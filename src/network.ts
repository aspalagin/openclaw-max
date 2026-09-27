/**
 * Per-account network settings: MAX API base URL and an outbound HTTP(S) proxy.
 *
 * The settings are bound to the bot token when the account is resolved
 * (resolveMaxAccount), and every MaxApi built for that token picks them up —
 * whichever send/action/lifecycle path built it. A bad value is bound as an
 * error, so requests fail with it instead of silently going out directly.
 *
 * Proxy credentials (http://user:pass@host:port) never reach logs or errors:
 * use redactProxyUrl() for display and scrubProxyCredentials() on errors that
 * crossed the proxy.
 */

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

/** Canonical MAX Bot API endpoint (platform-api.max.ru was shut down on 2026-07-19). */
export const DEFAULT_MAX_API_BASE_URL = 'https://platform-api2.max.ru';

export interface MaxNetwork {
  /** Base URL without a trailing slash; request paths are appended to it. */
  apiBaseUrl: string;
  /** Proxy for MAX API, upload and media download traffic; undefined = direct. */
  proxyUrl?: string;
}

/** A misconfigured apiBaseUrl/httpProxy; never retried, safe to log. */
export class MaxNetworkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaxNetworkConfigError';
  }
}

/** Loopback host: localhost names, 127.0.0.0/8, ::1 (URL.hostname form). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  if (isIP(host) === 6) return host === '::1' || host.startsWith('::ffff:127.');
  return false;
}

/** Whether requests to `url` bypass the proxy (loopback targets never use it). */
export function bypassesProxy(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Proxy URL for display: scheme, host and port; credentials become "***". */
export function redactProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    const auth = url.username || url.password ? '***@' : '';
    return `${url.protocol}//${auth}${url.host}`;
  } catch {
    return '<invalid URL>';
  }
}

/** Secret fragments of a proxy URL, as they may appear in error text. */
function proxySecrets(proxyUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    return [proxyUrl];
  }
  if (!url.username && !url.password) return [];
  const secrets = [proxyUrl, url.href];
  for (const part of [url.password, url.username]) {
    if (!part) continue;
    secrets.push(part);
    try {
      secrets.push(decodeURIComponent(part));
    } catch {
      // keep the encoded form only
    }
  }
  // longest first, so a URL is replaced whole before its parts
  return [...new Set(secrets.filter((s) => s.length > 0))].sort((a, b) => b.length - a.length);
}

/**
 * Remove proxy credentials from an error (message, and its cause chain) in
 * place and return it. No-op when the proxy URL carries no credentials.
 */
export function scrubProxyCredentials<T>(err: T, proxyUrl: string | undefined): T {
  if (!proxyUrl) return err;
  const secrets = proxySecrets(proxyUrl);
  if (secrets.length === 0) return err;
  const scrub = (text: string): string =>
    secrets.reduce((acc, secret) => acc.split(secret).join('***'), text);
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (secrets.some((s) => current instanceof Error && current.message.includes(s))) {
      current.message = scrub(current.message);
    }
    if (
      current.stack &&
      secrets.some((s) => current instanceof Error && current.stack?.includes(s))
    ) {
      current.stack = scrub(current.stack);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return err;
}

/**
 * Validate and normalize the account's apiBaseUrl/httpProxy. `configPath` is
 * the config prefix for messages ("channels.max" or "channels.max.accounts.x").
 * Throws MaxNetworkConfigError; messages never echo proxy credentials.
 */
export function resolveMaxNetwork(
  config: { apiBaseUrl?: unknown; httpProxy?: unknown },
  configPath = 'channels.max',
): MaxNetwork {
  return {
    apiBaseUrl: resolveApiBaseUrl(config.apiBaseUrl, `${configPath}.apiBaseUrl`),
    proxyUrl: resolveProxyUrl(config.httpProxy, `${configPath}.httpProxy`),
  };
}

function resolveApiBaseUrl(value: unknown, path: string): string {
  if (value === undefined || value === null) return DEFAULT_MAX_API_BASE_URL;
  if (typeof value !== 'string') throw new MaxNetworkConfigError(`${path} must be a string URL`);
  const raw = value.trim();
  if (!raw) return DEFAULT_MAX_API_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MaxNetworkConfigError(`${path} is not a valid URL (expected https://host[/path])`);
  }
  if (url.username || url.password) {
    throw new MaxNetworkConfigError(`${path} must not contain credentials`);
  }
  if (url.search || url.hash) {
    throw new MaxNetworkConfigError(`${path} must not contain a query or fragment: ${url.origin}`);
  }
  if (url.protocol === 'http:') {
    // The bot token rides in the Authorization header of every call.
    if (!isLoopbackHost(url.hostname)) {
      throw new MaxNetworkConfigError(
        `${path} must use https (http is allowed only for loopback hosts, the bot token would travel unencrypted): ${url.origin}`,
      );
    }
  } else if (url.protocol !== 'https:') {
    throw new MaxNetworkConfigError(`${path} must be an https URL: ${url.origin}`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

function resolveProxyUrl(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new MaxNetworkConfigError(`${path} must be a string URL`);
  const raw = value.trim();
  // "" turns an inherited channel-level proxy off for one account.
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MaxNetworkConfigError(`${path} is not a valid URL (expected http://host:port)`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MaxNetworkConfigError(
      `${path} must be an http:// or https:// proxy URL (got ${url.protocol}//…)`,
    );
  }
  if (!url.hostname) {
    throw new MaxNetworkConfigError(`${path} has no host: ${redactProxyUrl(raw)}`);
  }
  return raw;
}

// ────────────────────── Token binding ──────────────────────

type MaxNetworkBinding = MaxNetwork | { error: MaxNetworkConfigError };

const bindings = new Map<string, MaxNetworkBinding>();

/** Registry key: a token digest, not the token itself. */
export function maxTokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** Bind the account's network settings (or its config error) to its token. */
export function bindMaxNetwork(token: string, binding: MaxNetworkBinding): void {
  if (!token) return;
  bindings.set(maxTokenKey(token), binding);
}

/**
 * Network settings bound to a token; the default endpoint, direct, when the
 * token was never resolved from config (e.g. a setup-wizard probe). Throws the
 * bound config error.
 */
export function lookupMaxNetwork(token: string): MaxNetwork {
  const binding = bindings.get(maxTokenKey(token));
  if (!binding) return { apiBaseUrl: DEFAULT_MAX_API_BASE_URL };
  if ('error' in binding) throw binding.error;
  return binding;
}

export function resetMaxNetworkBindingsForTests(): void {
  bindings.clear();
}

/**
 * Options for runtime.channel.media.fetchRemoteMedia routing a download
 * through the account proxy (core SSRF guard, explicit-proxy dispatcher; the
 * proxy is operator-configured, so it may sit on a private address, and it
 * resolves the target DNS after the guard's hostname checks — as core's
 * Telegram channel does for its explicit proxy).
 */
export function proxiedMediaFetchOptions(proxyUrl: string | undefined): {
  dispatcherPolicy?: { mode: 'explicit-proxy'; proxyUrl: string; allowPrivateProxy: true };
  trustExplicitProxyDns?: true;
} {
  if (!proxyUrl) return {};
  return {
    dispatcherPolicy: { mode: 'explicit-proxy', proxyUrl, allowPrivateProxy: true },
    trustExplicitProxyDns: true,
  };
}
