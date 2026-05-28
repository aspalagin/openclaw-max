/**
 * Tests for MAX webhook handler
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  handleMaxWebhookRequest,
  registerMaxWebhookTarget,
  resolveMaxWebhookPath,
  subscribeMaxWebhook,
  unsubscribeMaxWebhook,
  type MaxWebhookTarget,
} from "./webhook.js";
import { MaxApi } from "./api.js";
import type { ResolvedMaxAccount } from "./accounts.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

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

  return Object.assign(readable, {
    method,
    url,
    headers,
  }) as IncomingMessage;
}

function createMockResponse(): ServerResponse & {
  _status?: number;
  _headers: Record<string, string>;
  _body: string;
} {
  const res: ServerResponse & {
    _status?: number;
    _headers: Record<string, string>;
    _body: string;
  } = {
    statusCode: 200,
    _status: undefined,
    _headers: {},
    _body: "",
    setHeader(name: string, value: string) {
      this._headers[name] = value;
      return this;
    },
    end(data?: string) {
      this._body = data ?? "";
      this._status = this.statusCode;
    },
  } as never;

  return res;
}

describe("MAX Webhook Handler", () => {
  describe("resolveMaxWebhookPath", () => {
    it("should use provided webhookPath", () => {
      const path = resolveMaxWebhookPath("/custom-path", undefined);
      expect(path).toBe("/custom-path");
    });

    it("should extract path from webhookUrl", () => {
      const path = resolveMaxWebhookPath(
        undefined,
        "https://example.com/api/max",
      );
      expect(path).toBe("/api/max");
    });

    it("should normalize path (add leading slash)", () => {
      const path = resolveMaxWebhookPath("custom", undefined);
      expect(path).toBe("/custom");
    });

    it("should remove trailing slash (except root)", () => {
      const path = resolveMaxWebhookPath("/api/max/", undefined);
      expect(path).toBe("/api/max");
    });

    it("should default to /max", () => {
      const path = resolveMaxWebhookPath(undefined, undefined);
      expect(path).toBe("/max");
    });

    it("should handle root path", () => {
      const path = resolveMaxWebhookPath("/", undefined);
      expect(path).toBe("/");
    });
  });

  describe("registerMaxWebhookTarget", () => {
    it("should register and unregister target", async () => {
      const mockAccount: ResolvedMaxAccount = {
        accountId: "default",
        enabled: true,
        token: "test-token",
        tokenSource: "config",
        config: {},
      };

      const mockConfig: OpenClawConfig = { channels: {} };
      const onUpdate = vi.fn();

      const target: MaxWebhookTarget = {
        account: mockAccount,
        config: mockConfig,
        path: "/test-webhook",
        onUpdate,
      };

      const unregister = registerMaxWebhookTarget(target);
      expect(typeof unregister).toBe("function");

      // Test that target is registered by making a webhook request
      const req = createMockRequest(
        "POST",
        "/test-webhook",
        {},
        JSON.stringify({
          update_type: "message_created",
          timestamp: Date.now(),
          message: {
            body: { mid: "msg-1", text: "Hello" },
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
        "POST",
        "/test-webhook",
        {},
        JSON.stringify({ update_type: "bot_started", timestamp: Date.now() }),
      );
      const res2 = createMockResponse();
      const handled2 = await handleMaxWebhookRequest(req2, res2);
      expect(handled2).toBe(false);
    });

    it("should normalize target path", async () => {
      const mockAccount: ResolvedMaxAccount = {
        accountId: "default",
        enabled: true,
        token: "token",
        tokenSource: "config",
        config: {},
      };
      const target: MaxWebhookTarget = {
        account: mockAccount,
        config: { channels: {} },
        path: "no-leading-slash",
        onUpdate: vi.fn(),
      };

      const unregister = registerMaxWebhookTarget(target);

      const req = createMockRequest(
        "POST",
        "/no-leading-slash",
        {},
        JSON.stringify({ update_type: "bot_started", timestamp: Date.now() }),
      );
      const res = createMockResponse();

      const handled = await handleMaxWebhookRequest(req, res);
      expect(handled).toBe(true);

      unregister();
    });
  });

  describe("handleMaxWebhookRequest", () => {
    it("should return false for non-registered path", async () => {
      const req = createMockRequest("POST", "/unknown-path");
      const res = createMockResponse();
      const handled = await handleMaxWebhookRequest(req, res);
      expect(handled).toBe(false);
    });

    it("should reject non-POST requests", async () => {
      const mockAccount: ResolvedMaxAccount = {
        accountId: "default",
        enabled: true,
        token: "token",
        tokenSource: "config",
        config: {},
      };
      const target: MaxWebhookTarget = {
        account: mockAccount,
        config: { channels: {} },
        path: "/test",
        onUpdate: vi.fn(),
      };
      const unregister = registerMaxWebhookTarget(target);

      const req = createMockRequest("GET", "/test");
      const res = createMockResponse();
      const handled = await handleMaxWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res._status).toBe(405);
      expect(res._headers.Allow).toBe("POST");

      unregister();
    });

    it("should verify webhook secret", async () => {
      const mockAccount: ResolvedMaxAccount = {
        accountId: "default",
        enabled: true,
        token: "token",
        tokenSource: "config",
        config: {},
      };
      const target: MaxWebhookTarget = {
        account: mockAccount,
        config: { channels: {} },
        path: "/secure",
        secret: "correct-secret",
        onUpdate: vi.fn(),
      };
      const unregister = registerMaxWebhookTarget(target);

      // Request without secret header
      const req1 = createMockRequest(
        "POST",
        "/secure",
        {},
        JSON.stringify({ update_type: "bot_started", timestamp: Date.now() }),
      );
      const res1 = createMockResponse();
      await handleMaxWebhookRequest(req1, res1);
      expect(res1._status).toBe(401);
      expect(target.onUpdate).not.toHaveBeenCalled();

      // Request with wrong secret
      const req2 = createMockRequest(
        "POST",
        "/secure",
        { "x-max-bot-api-secret": "wrong-secret" },
        JSON.stringify({ update_type: "bot_started", timestamp: Date.now() }),
      );
      const res2 = createMockResponse();
      await handleMaxWebhookRequest(req2, res2);
      expect(res2._status).toBe(401);

      // Request with correct secret
      const req3 = createMockRequest(
        "POST",
        "/secure",
        { "x-max-bot-api-secret": "correct-secret" },
        JSON.stringify({ update_type: "bot_started", timestamp: Date.now() }),
      );
      const res3 = createMockResponse();
      await handleMaxWebhookRequest(req3, res3);
      expect(res3._status).toBe(200);
      expect(target.onUpdate).toHaveBeenCalled();

      unregister();
    });

    it("should process valid update", async () => {
      const mockAccount: ResolvedMaxAccount = {
        accountId: "default",
        enabled: true,
        token: "token",
        tokenSource: "config",
        config: {},
      };
      const onUpdate = vi.fn().mockResolvedValue(undefined);
      const target: MaxWebhookTarget = {
        account: mockAccount,
        config: { channels: {} },
        path: "/hook",
        onUpdate,
      };
      const unregister = registerMaxWebhookTarget(target);

      const update = {
        update_type: "message_created",
        timestamp: Date.now(),
        message: {
          body: { mid: "msg-test", text: "Hello" },
          timestamp: Date.now(),
          recipient: { chat_id: 123 },
        },
      };

      const req = createMockRequest(
        "POST",
        "/hook",
        { "content-type": "application/json" },
        JSON.stringify(update),
      );
      const res = createMockResponse();

      await handleMaxWebhookRequest(req, res);

      expect(res._status).toBe(200);
      expect(onUpdate).toHaveBeenCalledWith(update);
      expect(res._body).toContain("ok");

      unregister();
    });

    it("should handle onUpdate errors", async () => {
      const mockAccount: ResolvedMaxAccount = {
        accountId: "default",
        enabled: true,
        token: "token",
        tokenSource: "config",
        config: {},
      };
      const onUpdate = vi.fn().mockRejectedValue(new Error("Processing failed"));
      const errorLog = vi.fn();
      const target: MaxWebhookTarget = {
        account: mockAccount,
        config: { channels: {} },
        path: "/error-test",
        onUpdate,
        error: errorLog,
      };
      const unregister = registerMaxWebhookTarget(target);

      const req = createMockRequest(
        "POST",
        "/error-test",
        {},
        JSON.stringify({ update_type: "bot_started", timestamp: Date.now() }),
      );
      const res = createMockResponse();

      await handleMaxWebhookRequest(req, res);

      expect(res._status).toBe(500);
      expect(errorLog).toHaveBeenCalled();

      unregister();
    });
  });

  describe("subscribeMaxWebhook", () => {
    it("should call API subscribe endpoint", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const api = new MaxApi({ token: "test-token" });
      await subscribeMaxWebhook({
        api,
        webhookUrl: "https://example.com/webhook",
        secret: "my-secret",
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/subscriptions"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("should include update types", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const api = new MaxApi({ token: "test-token" });
      await subscribeMaxWebhook({
        api,
        webhookUrl: "https://example.com/webhook",
        updateTypes: ["message_created", "bot_started"],
      });

      const callBody = JSON.parse(
        (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(callBody.update_types).toContain("message_created");
      expect(callBody.update_types).toContain("bot_started");
    });
  });

  describe("unsubscribeMaxWebhook", () => {
    it("should call API unsubscribe endpoint", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const api = new MaxApi({ token: "test-token" });
      await unsubscribeMaxWebhook({
        api,
        webhookUrl: "https://example.com/webhook",
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/subscriptions"),
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });
});
