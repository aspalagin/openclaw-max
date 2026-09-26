/**
 * Tests for MAX webhook handler
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { describe, expect, it, vi } from 'vitest';

import type { ResolvedMaxAccount } from './accounts.js';
import { MaxApi } from './api.js';
import {
  handleMaxWebhookRequest,
  maxUpdateDedupeKey,
  type MaxWebhookTarget,
  registerMaxWebhookRoute,
  registerMaxWebhookTarget,
  resolveMaxWebhookPath,
  subscribeMaxWebhook,
  unsubscribeMaxWebhook,
} from './webhook.js';

// Other tests replace global.fetch with mocks; the HTTP round trip needs the real one.
const realFetch = globalThis.fetch;

function createMockRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): IncomingMessage {
  const readable = new Readable({
    read() {
      if (body) {
        this.push(body);
      }
      this.push(null);
    },
  });

  // The SDK body reader checks the socket for a closing connection, as a real
  // IncomingMessage always carries one.
  return Object.assign(readable, {
    method,
    url,
    headers,
    socket: { destroyed: false, writableEnded: false },
  }) as unknown as IncomingMessage;
}

interface MockResponse extends ServerResponse {
  _status?: number;
  _headers: Record<string, string>;
  _body: string;
}

function createMockResponse(): MockResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = {} as any;
  return {
    ...base,
    statusCode: 200,
    _status: undefined,
    _headers: {},
    _body: '',
    setHeader(name: string, value: string) {
      this._headers[name] = value;
      return this;
    },
    end(data?: string) {
      this._body = data ?? '';
      this._status = this.statusCode;
    },
  } as MockResponse;
}

describe('MAX Webhook Handler', () => {
  describe('resolveMaxWebhookPath', () => {
    it('should use provided webhookPath', () => {
      const path = resolveMaxWebhookPath('/custom-path', undefined);
      expect(path).toBe('/custom-path');
    });

    it('should extract path from webhookUrl', () => {
      const path = resolveMaxWebhookPath(undefined, 'https://example.com/api/max');
      expect(path).toBe('/api/max');
    });

    it('should normalize path (add leading slash)', () => {
      const path = resolveMaxWebhookPath('custom', undefined);
      expect(path).toBe('/custom');
    });

    it('should remove trailing slash (except root)', () => {
      const path = resolveMaxWebhookPath('/api/max/', undefined);
      expect(path).toBe('/api/max');
    });

    it('should default to /max/webhook', () => {
      const path = resolveMaxWebhookPath(undefined, undefined);
      expect(path).toBe('/max/webhook');
    });

    it('should handle root path', () => {
      const path = resolveMaxWebhookPath('/', undefined);
      expect(path).toBe('/');
    });
  });

  describe('registerMaxWebhookTarget', () => {
    it('should register and unregister target', async () => {
      const mockAccount: ResolvedMaxAccount = {
        accountId: 'default',
        enabled: true,
        token: 'test-token',
        tokenSource: 'config',
        config: {},
      };

      const mockConfig: OpenClawConfig = { channels: {} };
      const onUpdate = vi.fn();

      const target: MaxWebhookTarget = {
        account: mockAccount,
        config: mockConfig,
        path: '/test-webhook',
        secret: 'reg-secret',
        onUpdate,
      };

      const unregister = registerMaxWebhookTarget(target);
      expect(typeof unregister).toBe('function');

      // Test that target is registered by making a webhook request
      const req = createMockRequest(
        'POST',
        '/test-webhook',
        { 'x-max-bot-api-secret': 'reg-secret' },
        JSON.stringify({
          update_type: 'message_created',
          timestamp: Date.now(),
          message: {
            body: { mid: 'msg-1', text: 'Hello' },
            timestamp: Date.now(),
            recipient: { chat_id: 123 },
          },
        }),
      );
      const res = createMockResponse();

      const handled = await handleMaxWebhookRequest(req, res);
      expect(handled).toBe(true);
      expect(onUpdate).toHaveBeenCalled();

      // Unregister
      unregister();

      // Request should not be handled after unregister
      const req2 = createMockRequest(
        'POST',
        '/test-webhook',
        { 'x-max-bot-api-secret': 'reg-secret' },
        JSON.stringify({ update_type: 'bot_started', timestamp: Date.now() }),
      );
      const res2 = createMockResponse();
      const handled2 = await handleMaxWebhookRequest(req2, res2);
      expect(handled2).toBe(false);
    });

    it('should normalize target path', async () => {
      const mockAccount: ResolvedMaxAccount = {
        accountId: 'default',
        enabled: true,
        token: 'token',
        tokenSource: 'config',
        config: {},
      };
      const target: MaxWebhookTarget = {
        account: mockAccount,
        config: { channels: {} },
        path: 'no-leading-slash',
        secret: 'norm-secret',
        onUpdate: vi.fn(),
      };

      const unregister = registerMaxWebhookTarget(target);

      const req = createMockRequest(
        'POST',
        '/no-leading-slash',
        { 'x-max-bot-api-secret': 'norm-secret' },
        JSON.stringify({ update_type: 'bot_started', timestamp: Date.now() }),
      );
      const res = createMockResponse();

      const handled = await handleMaxWebhookRequest(req, res);
      expect(handled).toBe(true);

      unregister();
    });
  });

  describe('handleMaxWebhookRequest', () => {
    it('should return false for non-registered path', async () => {
      const req = createMockRequest('POST', '/unknown-path');
      const res = createMockResponse();
      const handled = await handleMaxWebhookRequest(req, res);
      expect(handled).toBe(false);
    });

    it('should reject non-POST requests', async () => {
      const mockAccount: ResolvedMaxAccount = {
        accountId: 'default',
        enabled: true,
        token: 'token',
        tokenSource: 'config',
        config: {},
      };
      const target: MaxWebhookTarget = {
        account: mockAccount,
        config: { channels: {} },
        path: '/test',
        onUpdate: vi.fn(),
      };
      const unregister = registerMaxWebhookTarget(target);

      const req = createMockRequest('GET', '/test');
      const res = createMockResponse();
      const handled = await handleMaxWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res._status).toBe(405);
      expect(res._headers.Allow).toBe('POST');

      unregister();
    });

    it('should verify webhook secret', async () => {
      const mockAccount: ResolvedMaxAccount = {
        accountId: 'default',
        enabled: true,
        token: 'token',
        tokenSource: 'config',
        config: {},
      };
      const target: MaxWebhookTarget = {
        account: mockAccount,
        config: { channels: {} },
        path: '/secure',
        secret: 'correct-secret',
        onUpdate: vi.fn(),
      };
      const unregister = registerMaxWebhookTarget(target);

      // Request without secret header
      const req1 = createMockRequest(
        'POST',
        '/secure',
        {},
        JSON.stringify({ update_type: 'bot_started', timestamp: Date.now() }),
      );
      const res1 = createMockResponse();
      await handleMaxWebhookRequest(req1, res1);
      expect(res1._status).toBe(401);
      expect(target.onUpdate).not.toHaveBeenCalled();

      // Request with wrong secret
      const req2 = createMockRequest(
        'POST',
        '/secure',
        { 'x-max-bot-api-secret': 'wrong-secret' },
        JSON.stringify({ update_type: 'bot_started', timestamp: Date.now() }),
      );
      const res2 = createMockResponse();
      await handleMaxWebhookRequest(req2, res2);
      expect(res2._status).toBe(401);

      // Request with correct secret
      const req3 = createMockRequest(
        'POST',
        '/secure',
        { 'x-max-bot-api-secret': 'correct-secret' },
        JSON.stringify({ update_type: 'bot_started', timestamp: Date.now() }),
      );
      const res3 = createMockResponse();
      await handleMaxWebhookRequest(req3, res3);
      expect(res3._status).toBe(200);
      expect(target.onUpdate).toHaveBeenCalled();

      unregister();
    });

    it('should reject a malformed JSON body with 400 before dispatch', async () => {
      const onUpdate = vi.fn();
      const unregister = registerMaxWebhookTarget({
        account: {
          accountId: 'default',
          enabled: true,
          token: 'token',
          tokenSource: 'config',
          config: {},
        },
        config: { channels: {} },
        path: '/bad-json',
        secret: 's',
        onUpdate,
      });

      const req = createMockRequest(
        'POST',
        '/bad-json',
        { 'x-max-bot-api-secret': 's' },
        '{not json',
      );
      const res = createMockResponse();
      const handled = await handleMaxWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res._status).toBe(400);
      expect(res._body).toBe('invalid payload');
      expect(onUpdate).not.toHaveBeenCalled();

      unregister();
    });

    it('should never match a target that has no secret configured', async () => {
      const mockAccount: ResolvedMaxAccount = {
        accountId: 'default',
        enabled: true,
        token: 'token',
        tokenSource: 'config',
        config: {},
      };
      const onUpdate = vi.fn();
      const target: MaxWebhookTarget = {
        account: mockAccount,
        config: { channels: {} },
        path: '/no-secret',
        onUpdate,
      };
      const unregister = registerMaxWebhookTarget(target);

      const req = createMockRequest(
        'POST',
        '/no-secret',
        {},
        JSON.stringify({ update_type: 'bot_started', timestamp: Date.now() }),
      );
      const res = createMockResponse();
      await handleMaxWebhookRequest(req, res);

      expect(res._status).toBe(401);
      expect(onUpdate).not.toHaveBeenCalled();

      unregister();
    });

    it('should process valid update', async () => {
      const mockAccount: ResolvedMaxAccount = {
        accountId: 'default',
        enabled: true,
        token: 'token',
        tokenSource: 'config',
        config: {},
      };
      const onUpdate = vi.fn().mockResolvedValue(undefined);
      const target: MaxWebhookTarget = {
        account: mockAccount,
        config: { channels: {} },
        path: '/hook',
        secret: 'hook-secret',
        onUpdate,
      };
      const unregister = registerMaxWebhookTarget(target);

      const update = {
        update_type: 'message_created',
        timestamp: Date.now(),
        message: {
          body: { mid: 'msg-test', text: 'Hello' },
          timestamp: Date.now(),
          recipient: { chat_id: 123 },
        },
      };

      const req = createMockRequest(
        'POST',
        '/hook',
        { 'content-type': 'application/json', 'x-max-bot-api-secret': 'hook-secret' },
        JSON.stringify(update),
      );
      const res = createMockResponse();

      await handleMaxWebhookRequest(req, res);

      expect(res._status).toBe(200);
      expect(onUpdate).toHaveBeenCalledWith(update);
      expect(res._body).toContain('ok');

      unregister();
    });

    it('should ack 200 and log onUpdate errors asynchronously', async () => {
      const mockAccount: ResolvedMaxAccount = {
        accountId: 'default',
        enabled: true,
        token: 'token',
        tokenSource: 'config',
        config: {},
      };
      const onUpdate = vi.fn().mockRejectedValue(new Error('Processing failed'));
      const errorLog = vi.fn();
      const target: MaxWebhookTarget = {
        account: mockAccount,
        config: { channels: {} },
        path: '/error-test',
        secret: 'err-secret',
        onUpdate,
        error: errorLog,
      };
      const unregister = registerMaxWebhookTarget(target);

      const req = createMockRequest(
        'POST',
        '/error-test',
        { 'x-max-bot-api-secret': 'err-secret' },
        JSON.stringify({ update_type: 'bot_started', timestamp: Date.now() }),
      );
      const res = createMockResponse();

      await handleMaxWebhookRequest(req, res);

      // MAX only needs the 200; a processing failure must not trigger redelivery.
      expect(res._status).toBe(200);
      await vi.waitFor(() => expect(errorLog).toHaveBeenCalled());
      expect(String(errorLog.mock.calls[0][0])).toContain('Processing failed');

      unregister();
    });

    it('should answer 200 before a slow update finishes', async () => {
      let release!: () => void;
      const onUpdate = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const unregister = registerMaxWebhookTarget({
        account: {
          accountId: 'default',
          enabled: true,
          token: 't',
          tokenSource: 'config',
          config: {},
        },
        config: { channels: {} },
        path: '/slow',
        secret: 'slow-secret',
        onUpdate,
      });

      const res = createMockResponse();
      await handleMaxWebhookRequest(
        createMockRequest(
          'POST',
          '/slow',
          { 'x-max-bot-api-secret': 'slow-secret' },
          JSON.stringify({ update_type: 'bot_started', timestamp: 1 }),
        ),
        res,
      );
      expect(res._status).toBe(200);
      await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
      release();
      unregister();
    });

    it('should reject a body without update_type with 400', async () => {
      const onUpdate = vi.fn();
      const unregister = registerMaxWebhookTarget({
        account: {
          accountId: 'default',
          enabled: true,
          token: 't',
          tokenSource: 'config',
          config: {},
        },
        config: { channels: {} },
        path: '/shape',
        secret: 'shape-secret',
        onUpdate,
      });
      const res = createMockResponse();
      await handleMaxWebhookRequest(
        createMockRequest(
          'POST',
          '/shape',
          { 'x-max-bot-api-secret': 'shape-secret' },
          JSON.stringify({ hello: 1 }),
        ),
        res,
      );
      expect(res._status).toBe(400);
      expect(onUpdate).not.toHaveBeenCalled();
      unregister();
    });

    it('should reject a missing secret header with 401 without reading the body', async () => {
      const onUpdate = vi.fn();
      const unregister = registerMaxWebhookTarget({
        account: {
          accountId: 'default',
          enabled: true,
          token: 't',
          tokenSource: 'config',
          config: {},
        },
        config: { channels: {} },
        path: '/nosecret',
        secret: 'right-secret',
        onUpdate,
      });
      const req = createMockRequest('POST', '/nosecret', {}, '{not json');
      const res = createMockResponse();
      await handleMaxWebhookRequest(req, res);
      expect(res._status).toBe(401);
      expect(onUpdate).not.toHaveBeenCalled();
      unregister();
    });

    it('should drop redelivered duplicates (same type, timestamp and mid)', async () => {
      const onUpdate = vi.fn().mockResolvedValue(undefined);
      const unregister = registerMaxWebhookTarget({
        account: {
          accountId: 'default',
          enabled: true,
          token: 't',
          tokenSource: 'config',
          config: {},
        },
        config: { channels: {} },
        path: '/dedupe',
        secret: 'dedupe-secret',
        onUpdate,
      });
      const update = {
        update_type: 'message_created',
        timestamp: 1_700_000_000_000,
        message: { body: { mid: 'mid.dup', text: 'x' }, timestamp: 1, recipient: { chat_id: 1 } },
      };
      const send = async (body: object) => {
        const res = createMockResponse();
        await handleMaxWebhookRequest(
          createMockRequest(
            'POST',
            '/dedupe',
            { 'x-max-bot-api-secret': 'dedupe-secret' },
            JSON.stringify(body),
          ),
          res,
        );
        return res;
      };

      expect((await send(update))._status).toBe(200);
      expect((await send(update))._status).toBe(200);
      await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
      await send({
        ...update,
        message: { ...update.message, body: { mid: 'mid.other', text: 'y' } },
      });
      await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
      unregister();
    });
  });

  describe('maxUpdateDedupeKey', () => {
    it('keys callbacks by callback_id and messages by mid', () => {
      expect(
        maxUpdateDedupeKey({
          update_type: 'message_callback',
          timestamp: 5,
          callback: { callback_id: 'cb.1', timestamp: 5, user: { user_id: 1, first_name: 'a' } },
        } as never),
      ).toBe('message_callback:5:cb.1');
      expect(
        maxUpdateDedupeKey({
          update_type: 'message_created',
          timestamp: 6,
          message: { body: { mid: 'mid.6' } },
        } as never),
      ).toBe('message_created:6:mid.6');
    });
  });

  describe('registerMaxWebhookRoute', () => {
    it('registers a plugin-auth exact route owned by the plugin, strict', () => {
      const unregister = vi.fn();
      const register = vi.fn(() => unregister);
      const result = registerMaxWebhookRoute({
        path: 'max/webhook/',
        accountId: 'default',
        register: register as never,
      });

      expect(result).toBe(unregister);
      expect(register).toHaveBeenCalledTimes(1);
      const params = (register.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(params).toMatchObject({
        path: '/max/webhook',
        auth: 'plugin',
        match: 'exact',
        pluginId: 'openclaw-max',
        source: 'max-webhook',
        accountId: 'default',
        replaceExisting: true,
        throwOnFailure: true,
      });
      expect(params.handler).toBe(handleMaxWebhookRequest);
    });
  });

  describe('gateway route over a real HTTP server', () => {
    it('serves 200/401/405/404 through handleMaxWebhookRequest', async () => {
      const { createServer } = await import('node:http');
      const onUpdate = vi.fn().mockResolvedValue(undefined);
      const unregister = registerMaxWebhookTarget({
        account: {
          accountId: 'default',
          enabled: true,
          token: 't',
          tokenSource: 'config',
          config: {},
        },
        config: { channels: {} },
        path: '/max/webhook',
        secret: 'live-secret',
        onUpdate,
      });
      // Stand-in for the gateway: a route handler returning false falls through to 404.
      const server = createServer((req, res) => {
        void handleMaxWebhookRequest(req, res).then((handled) => {
          if (!handled) {
            res.statusCode = 404;
            res.end('Not Found');
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as { port: number };
      const base = `http://127.0.0.1:${port}`;
      const update = {
        update_type: 'message_created',
        timestamp: 1_700_000_000_001,
        message: { body: { mid: 'mid.http', text: 'hi' }, timestamp: 1, recipient: { chat_id: 7 } },
      };
      try {
        const ok = await realFetch(`${base}/max/webhook`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Max-Bot-Api-Secret': 'live-secret' },
          body: JSON.stringify(update),
        });
        expect(ok.status).toBe(200);
        expect(await ok.json()).toEqual({ ok: true });
        await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith(update));

        const bad = await realFetch(`${base}/max/webhook`, {
          method: 'POST',
          headers: { 'X-Max-Bot-Api-Secret': 'wrong-secret' },
          body: JSON.stringify(update),
        });
        expect(bad.status).toBe(401);

        const get = await realFetch(`${base}/max/webhook`);
        expect(get.status).toBe(405);

        const other = await realFetch(`${base}/elsewhere`, { method: 'POST', body: '{}' });
        expect(other.status).toBe(404);
        expect(onUpdate).toHaveBeenCalledTimes(1);
      } finally {
        unregister();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('subscribeMaxWebhook', () => {
    it('should call API subscribe endpoint', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const api = new MaxApi({ token: 'test-token' });
      await subscribeMaxWebhook({
        api,
        webhookUrl: 'https://example.com/webhook',
        secret: 'my-secret',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/subscriptions'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should include update types', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const api = new MaxApi({ token: 'test-token' });
      await subscribeMaxWebhook({
        api,
        webhookUrl: 'https://example.com/webhook',
        updateTypes: ['message_created', 'bot_started'],
      });

      const callBody = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(callBody.update_types).toContain('message_created');
      expect(callBody.update_types).toContain('bot_started');
    });
  });

  describe('unsubscribeMaxWebhook', () => {
    it('should call API unsubscribe endpoint', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const api = new MaxApi({ token: 'test-token' });
      await unsubscribeMaxWebhook({
        api,
        webhookUrl: 'https://example.com/webhook',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/subscriptions'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });
});
