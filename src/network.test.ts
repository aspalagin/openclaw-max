/**
 * Tests for per-account network settings: apiBaseUrl, httpProxy, their
 * validation, the token binding, proxy routing and credential redaction.
 */

import { once } from 'node:events';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { type AddressInfo, connect as netConnect, type Socket } from 'node:net';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import type * as Undici from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveMaxAccount } from './accounts.js';
import { getMaxDispatcher, MaxApi, setMaxFetchForTests } from './api.js';
import { maxGatewayAdapter } from './channel-lifecycle.js';
import { fetchMaxRemoteMedia } from './media-temp.js';
import {
  bindMaxNetwork,
  DEFAULT_MAX_API_BASE_URL,
  isLoopbackHost,
  lookupMaxNetwork,
  MaxNetworkConfigError,
  redactProxyUrl,
  resolveMaxNetwork,
  scrubProxyCredentials,
} from './network.js';
import { setMaxRuntime } from './runtime.js';
import { RUSSIAN_TRUSTED_ROOT_CA, RUSSIAN_TRUSTED_SUB_CA } from './russian-trusted-ca.js';

const SECRET = 's3cr3t-Pa55';

function maxCfg(max: Record<string, unknown>): OpenClawConfig {
  return { channels: { max } } as unknown as OpenClawConfig;
}

describe('resolveMaxNetwork', () => {
  it('defaults to the public endpoint, direct', () => {
    expect(resolveMaxNetwork({})).toEqual({
      apiBaseUrl: DEFAULT_MAX_API_BASE_URL,
      proxyUrl: undefined,
    });
    expect(resolveMaxNetwork({ apiBaseUrl: '  ', httpProxy: '' })).toEqual({
      apiBaseUrl: DEFAULT_MAX_API_BASE_URL,
      proxyUrl: undefined,
    });
  });

  it('keeps an https base URL with its path prefix, without the trailing slash', () => {
    expect(resolveMaxNetwork({ apiBaseUrl: 'https://stand.example.test/max/' }).apiBaseUrl).toBe(
      'https://stand.example.test/max',
    );
  });

  it('accepts http only for loopback hosts', () => {
    for (const url of ['http://127.0.0.1:8080', 'http://localhost:9000/api', 'http://[::1]:81']) {
      expect(resolveMaxNetwork({ apiBaseUrl: url }).apiBaseUrl).toBe(url.replace(/\/$/, ''));
    }
    expect(() => resolveMaxNetwork({ apiBaseUrl: 'http://stand.example.test' })).toThrow(
      /channels\.max\.apiBaseUrl must use https \(http is allowed only for loopback hosts/,
    );
    expect(() => resolveMaxNetwork({ apiBaseUrl: 'http://10.0.0.5' })).toThrow(
      MaxNetworkConfigError,
    );
  });

  it('rejects other schemes, credentials, queries and garbage with the config path', () => {
    const path = 'channels.max.accounts.two';
    expect(() => resolveMaxNetwork({ apiBaseUrl: 'ftp://x.example.test' }, path)).toThrow(
      'channels.max.accounts.two.apiBaseUrl must be an https URL',
    );
    expect(() => resolveMaxNetwork({ apiBaseUrl: 'https://u:p@x.example.test' }, path)).toThrow(
      /must not contain credentials/,
    );
    expect(() => resolveMaxNetwork({ apiBaseUrl: 'https://x.example.test/?a=1' }, path)).toThrow(
      /must not contain a query/,
    );
    expect(() => resolveMaxNetwork({ apiBaseUrl: 'not a url' }, path)).toThrow(
      /apiBaseUrl is not a valid URL/,
    );
  });

  it('accepts http and https proxies, rejects the rest without echoing credentials', () => {
    expect(resolveMaxNetwork({ httpProxy: ' http://proxy.example.test:3128 ' }).proxyUrl).toBe(
      'http://proxy.example.test:3128',
    );
    expect(resolveMaxNetwork({ httpProxy: 'https://proxy.example.test' }).proxyUrl).toBe(
      'https://proxy.example.test',
    );
    const bad = [`socks5://u:${SECRET}@proxy.example.test:1080`, `u:${SECRET}@proxy`];
    for (const httpProxy of bad) {
      let error: unknown;
      try {
        resolveMaxNetwork({ httpProxy });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(MaxNetworkConfigError);
      expect(String(error)).toMatch(/channels\.max\.httpProxy/);
      expect(String(error)).not.toContain(SECRET);
    }
  });
});

describe('redaction', () => {
  it('shows scheme, host and port only', () => {
    expect(redactProxyUrl(`http://user:${SECRET}@proxy.example.test:3128/`)).toBe(
      'http://***@proxy.example.test:3128',
    );
    expect(redactProxyUrl('https://proxy.example.test')).toBe('https://proxy.example.test');
    expect(redactProxyUrl(`::${SECRET}`)).toBe('<invalid URL>');
  });

  it('scrubs the URL, password and user from an error and its causes', () => {
    const proxyUrl = `http://us%40er:${SECRET}@proxy.example.test:3128`;
    const cause = new Error(`connect via ${proxyUrl} failed for us@er:${SECRET}`);
    const err = new TypeError('fetch failed', { cause });
    scrubProxyCredentials(err, proxyUrl);
    expect(cause.message).not.toContain(SECRET);
    expect(cause.message).not.toContain('us@er');
    expect(String(cause.stack)).not.toContain(SECRET);
    expect(err.message).toBe('fetch failed');
  });

  it('recognizes loopback hosts', () => {
    for (const host of ['localhost', 'api.localhost', '127.0.0.1', '127.1.2.3', '[::1]']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ['platform-api2.max.ru', '10.0.0.1', '::2', 'localhost.example.test']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe('token binding', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('binds the account settings to its token; named accounts inherit, "" turns the proxy off', () => {
    const cfg = maxCfg({
      botToken: 'top-token',
      httpProxy: 'http://proxy.example.test:3128',
      apiBaseUrl: 'https://stand.example.test/max',
      accounts: {
        two: { botToken: 'two-token' },
        three: { botToken: 'three-token', httpProxy: '' },
      },
    });
    for (const accountId of ['default', 'two', 'three']) resolveMaxAccount({ cfg, accountId });
    expect(lookupMaxNetwork('top-token')).toEqual({
      apiBaseUrl: 'https://stand.example.test/max',
      proxyUrl: 'http://proxy.example.test:3128',
    });
    expect(lookupMaxNetwork('two-token').proxyUrl).toBe('http://proxy.example.test:3128');
    expect(lookupMaxNetwork('three-token')).toEqual({
      apiBaseUrl: 'https://stand.example.test/max',
      proxyUrl: undefined,
    });
    expect(lookupMaxNetwork('unknown-token')).toEqual({ apiBaseUrl: DEFAULT_MAX_API_BASE_URL });
  });

  it('sends API calls to the bound base URL, path prefix included', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ user_id: 1 })));
    vi.stubGlobal('fetch', fetchMock);
    resolveMaxAccount({
      cfg: maxCfg({ botToken: 'tok', apiBaseUrl: 'https://stand.example.test/max/' }),
    });
    await new MaxApi({ token: 'tok' }).getMe();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://stand.example.test/max/me');
  });

  it('fails every request of a misconfigured account, without retries or a direct fallback', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    resolveMaxAccount({
      cfg: maxCfg({
        accounts: { two: { botToken: 'tok2', httpProxy: `socks5://u:${SECRET}@p:1` } },
      }),
      accountId: 'two',
    });
    const api = new MaxApi({ token: 'tok2', retryAttempts: 3 });
    const error = await api.getMe().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MaxNetworkConfigError);
    expect(String(error)).toContain('channels.max.accounts.two.httpProxy');
    expect(String(error)).not.toContain(SECRET);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => api.mediaProxyUrl()).toThrow(MaxNetworkConfigError);
  });

  it('stops the account at start with a clear error that hides the proxy credentials', async () => {
    const account = resolveMaxAccount({
      cfg: maxCfg({ botToken: 'tok3', apiBaseUrl: 'http://stand.example.test' }),
    });
    await expect(maxGatewayAdapter.startAccount!({ account } as never)).rejects.toThrow(
      /channels\.max\.apiBaseUrl must use https/,
    );
    const proxied = resolveMaxAccount({
      cfg: maxCfg({ botToken: 'tok4', httpProxy: `ftp://u:${SECRET}@proxy.example.test` }),
    });
    const error = await maxGatewayAdapter.startAccount!({ account: proxied } as never).catch(
      (err: unknown) => err,
    );
    expect(String(error)).toContain(
      'channels.max.httpProxy must be an http:// or https:// proxy URL',
    );
    expect(String(error)).not.toContain(SECRET);
  });
});

describe('dispatcher selection', () => {
  it('tunnels through a ProxyAgent that verifies MAX with the Russian Trusted CA', async () => {
    // A fresh api module over a recording ProxyAgent (the setup file already
    // loaded api.ts with the real undici).
    const proxyAgentOptions: Array<Record<string, unknown>> = [];
    vi.resetModules();
    vi.doMock('undici', async (importOriginal) => {
      const actual = await importOriginal<typeof Undici>();
      class RecordingProxyAgent extends actual.ProxyAgent {
        constructor(opts: ConstructorParameters<typeof actual.ProxyAgent>[0]) {
          super(opts);
          proxyAgentOptions.push(opts as unknown as Record<string, unknown>);
        }
      }
      return { ...actual, ProxyAgent: RecordingProxyAgent };
    });
    const fresh = await import('./api.js');
    vi.doUnmock('undici');
    const proxyUrl = 'http://proxy-ca.example.test:3128';
    const first = fresh.getMaxDispatcher('https://platform-api2.max.ru/me', proxyUrl);
    const again = fresh.getMaxDispatcher('https://upload.example.test/x', proxyUrl);
    expect(again).toBe(first);
    expect(proxyAgentOptions).toHaveLength(1);
    const options = proxyAgentOptions[0] as { uri: string; requestTls: { ca: string[] } };
    expect(options.uri).toBe(proxyUrl);
    expect(options.requestTls.ca).toContain(RUSSIAN_TRUSTED_ROOT_CA);
    expect(options.requestTls.ca).toContain(RUSSIAN_TRUSTED_SUB_CA);
  });

  it('never proxies loopback targets and goes direct without a proxy', () => {
    const direct = getMaxDispatcher('https://platform-api2.max.ru/me');
    expect(getMaxDispatcher('http://127.0.0.1:8080/me', 'http://proxy.example.test:3128')).toBe(
      direct,
    );
    expect(
      getMaxDispatcher('https://platform-api2.max.ru/me', 'http://proxy.example.test:3128'),
    ).not.toBe(direct);
  });
});

describe('media downloads', () => {
  it('route the runtime media fetch through the account proxy', async () => {
    const fetchRemoteMedia = vi.fn(async () => ({
      buffer: Buffer.from('x'),
      contentType: 'image/png',
    }));
    setMaxRuntime({ channel: { media: { fetchRemoteMedia } } } as never);
    await fetchMaxRemoteMedia(
      'https://cdn.example.test/a.png',
      10,
      'http://proxy.example.test:3128',
    );
    expect(fetchRemoteMedia).toHaveBeenCalledWith({
      url: 'https://cdn.example.test/a.png',
      maxBytes: 10,
      dispatcherPolicy: {
        mode: 'explicit-proxy',
        proxyUrl: 'http://proxy.example.test:3128',
        allowPrivateProxy: true,
      },
      trustExplicitProxyDns: true,
    });
    await fetchMaxRemoteMedia('https://cdn.example.test/b.png', 10);
    expect(fetchRemoteMedia).toHaveBeenLastCalledWith({
      url: 'https://cdn.example.test/b.png',
      maxBytes: 10,
    });
  });

  it('keep proxy credentials out of download errors', async () => {
    const proxyUrl = `http://user:${SECRET}@proxy.example.test:3128`;
    const fetchRemoteMedia = vi.fn(async () => {
      throw new Error(`Failed to fetch media: proxy ${proxyUrl} refused`);
    });
    setMaxRuntime({ channel: { media: { fetchRemoteMedia } } } as never);
    const error = await fetchMaxRemoteMedia('https://cdn.example.test/a', 10, proxyUrl).catch(
      (err: unknown) => err,
    );
    expect(String(error)).toContain('Failed to fetch media');
    expect(String(error)).not.toContain(SECRET);
  });
});

describe('through a real proxy', () => {
  const servers: Server[] = [];
  const sockets = new Set<Socket>();

  async function listen(server: Server): Promise<number> {
    servers.push(server);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return (server.address() as AddressInfo).port;
  }

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  it('uploads through the proxy with its credentials; loopback API calls go direct', async () => {
    setMaxFetchForTests(undefined);
    const apiHits: Array<{ url?: string; auth?: string }> = [];
    const apiPort = await listen(
      createServer((req, res) => {
        apiHits.push({ url: req.url, auth: req.headers.authorization });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ url: 'http://upload.max.test/upload?id=1', token: 'att-token' }));
      }),
    );
    const uploads: string[] = [];
    const uploadPort = await listen(
      createServer((req, res) => {
        uploads.push(`${req.method} ${req.url}`);
        req.resume();
        req.on('end', () => res.end('<retval>1</retval>'));
      }),
    );
    const proxyHits: Array<{ method?: string; target?: string; auth?: string }> = [];
    const proxy = createServer((req, res) => {
      // absolute-form forwarding (no tunnel)
      proxyHits.push({
        method: req.method,
        target: req.url,
        auth: req.headers['proxy-authorization'],
      });
      const target = new URL(req.url ?? '');
      const upstream = httpRequest(
        {
          host: '127.0.0.1',
          port: uploadPort,
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers: req.headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      req.pipe(upstream);
    });
    proxy.on('connect', (req, socket: Socket, head: Buffer) => {
      proxyHits.push({
        method: 'CONNECT',
        target: req.url,
        auth: req.headers['proxy-authorization'],
      });
      sockets.add(socket);
      const upstream = netConnect(uploadPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      sockets.add(upstream);
    });
    const proxyPort = await listen(proxy);

    const api = new MaxApi({
      token: 'bot-token',
      sendLimiter: null,
      network: {
        apiBaseUrl: `http://127.0.0.1:${apiPort}`,
        proxyUrl: `http://us%40er:${SECRET}@127.0.0.1:${proxyPort}`,
      },
    });
    const uploaded = await api.uploadMedia('file', Buffer.from('hello'), 'text/plain', 'a.txt');

    expect(uploaded.token).toBe('att-token');
    expect(apiHits).toEqual([{ url: '/uploads?type=file', auth: 'bot-token' }]);
    expect(uploads).toEqual(['POST /upload?id=1']);
    expect(proxyHits).toHaveLength(1);
    expect(proxyHits[0]?.target).toMatch(/upload\.max\.test/);
    expect(proxyHits[0]?.auth).toBe(`Basic ${Buffer.from(`us@er:${SECRET}`).toString('base64')}`);
  });

  it('logs and throws proxy failures without the proxy credentials', async () => {
    setMaxFetchForTests(undefined);
    const closed = createServer();
    const closedPort = await listen(closed);
    await new Promise((r) => closed.close(r));
    servers.splice(servers.indexOf(closed), 1);

    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    const proxyUrl = `http://user:${SECRET}@127.0.0.1:${closedPort}`;
    bindMaxNetwork('bot-token-2', { apiBaseUrl: 'https://api.max.test', proxyUrl });
    const api = new MaxApi({ token: 'bot-token-2', timeoutMs: 5_000 });
    const error = (await api.getMe().catch((err: unknown) => err)) as Error;
    spy.mockRestore();

    expect(error).toBeInstanceOf(Error);
    const seen = [
      String(error),
      String(error.stack),
      String((error as { cause?: unknown }).cause),
      String(((error as { cause?: { stack?: string } }).cause ?? {}).stack),
      ...logged,
    ].join('\n');
    expect(seen).not.toContain(SECRET);
    expect(logged.join('\n')).toContain('[MAX API] GET /me failed');
  });
});
