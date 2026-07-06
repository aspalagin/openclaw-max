/**
 * Tests for MAX Bot API client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MaxApi, MaxApiError } from "./api.js";

const MOCK_TOKEN = "test-bot-token";
const MOCK_BASE_URL = "https://test-api.max.ru";

describe("MaxApi", () => {
  let api: MaxApi;

  beforeEach(() => {
    api = new MaxApi({ token: MOCK_TOKEN, baseUrl: MOCK_BASE_URL });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should create instance with provided options", () => {
      const customApi = new MaxApi({
        token: "custom-token",
        baseUrl: "https://custom.api",
        timeoutMs: 5000,
      });
      expect(customApi).toBeInstanceOf(MaxApi);
    });

    it("should use default baseUrl if not provided", () => {
      const defaultApi = new MaxApi({ token: MOCK_TOKEN });
      expect(defaultApi).toBeInstanceOf(MaxApi);
    });
  });

  describe("getMe", () => {
    it("should fetch bot info", async () => {
      const mockUser = {
        user_id: 12345,
        first_name: "TestBot",
        username: "testbot",
        is_bot: true,
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockUser,
      });

      const result = await api.getMe();
      expect(result).toEqual(mockUser);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/me"),
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: MOCK_TOKEN,
          }),
        }),
      );
    });

    it("should handle API errors", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: "Unauthorized" }),
      });

      await expect(api.getMe()).rejects.toThrow(MaxApiError);
    });
  });

  describe("sendMessage", () => {
    it("should send text message", async () => {
      const mockResult = {
        message: {
          body: { mid: "msg-123", text: "Hello" },
          timestamp: Date.now(),
          recipient: { chat_id: 123 },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      const result = await api.sendMessage(
        { text: "Hello" },
        { chat_id: 123 },
      );

      expect(result).toEqual(mockResult);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/messages"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: MOCK_TOKEN,
            "Content-Type": "application/json",
          }),
        }),
      );
    });

    it("should send message with markdown format", async () => {
      const mockResult = {
        message: {
          body: { mid: "msg-124", text: "**Bold**" },
          timestamp: Date.now(),
          recipient: { chat_id: 456 },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      await api.sendMessage(
        { text: "**Bold**", format: "markdown" },
        { chat_id: 456 },
      );

      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("editMessage", () => {
    it("should edit existing message", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await api.editMessage("msg-123", { text: "Updated text" });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/messages?message_id=msg-123"),
        expect.objectContaining({
          method: "PUT",
        }),
      );
    });
  });

  describe("deleteMessage", () => {
    it("should delete message", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await api.deleteMessage("msg-456");

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/messages?message_id=msg-456"),
        expect.objectContaining({
          method: "DELETE",
        }),
      );
    });
  });

  describe("getChats", () => {
    it("should fetch chats list", async () => {
      const mockChats = {
        chats: [
          { chat_id: 1, type: "dialog" as const, status: "active" },
          { chat_id: 2, type: "chat" as const, status: "active", title: "Group" },
        ],
        marker: null,
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockChats,
      });

      const result = await api.getChats({ count: 10 });
      expect(result.chats).toHaveLength(2);
    });
  });

  describe("getChat", () => {
    it("should fetch single chat info", async () => {
      const mockChat = {
        chat_id: 123,
        type: "chat" as const,
        status: "active",
        title: "Test Group",
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockChat,
      });

      const result = await api.getChat(123);
      expect(result.chat_id).toBe(123);
    });
  });

  describe("getUpdates", () => {
    it("should poll for updates", async () => {
      const mockUpdates = {
        updates: [
          {
            update_type: "message_created" as const,
            timestamp: Date.now(),
            message: {
              body: { mid: "msg-789", text: "Hello" },
              timestamp: Date.now(),
              recipient: { chat_id: 123 },
            },
          },
        ],
        marker: 456,
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockUpdates,
      });

      const result = await api.getUpdates({ timeout: 30, limit: 100 });
      expect(result.updates).toHaveLength(1);
      expect(result.marker).toBe(456);
    });
  });

  describe("setMyCommands", () => {
    it("should register commands via PATCH /me (there is no /me/commands endpoint)", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user_id: 1, first_name: "Bot", is_bot: true }),
      });

      const commands = [
        { name: "start", description: "Start bot" },
        { name: "help", description: "Show help" },
      ];

      await api.setMyCommands(commands);

      const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { method: string; body: string }];
      expect(url).toBe(`${MOCK_BASE_URL}/me`);
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body)).toEqual({ commands });
    });

    it("should normalize commands: strip slash, clamp lengths, cap at 32", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user_id: 1, first_name: "Bot", is_bot: true }),
      });

      const many = Array.from({ length: 40 }, (_, i) => ({
        name: `/cmd${i}`,
        description: "x".repeat(200),
      }));
      await api.setMyCommands(many);

      const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { body: string }];
      const sent = JSON.parse(init.body).commands as Array<{ name: string; description?: string }>;
      expect(sent).toHaveLength(32);
      expect(sent[0].name).toBe("cmd0");
      expect(sent[0].description).toHaveLength(128);
    });
  });

  describe("retries", () => {
    it("should retry once on 429 and succeed", async () => {
      const retryApi = new MaxApi({ token: MOCK_TOKEN, baseUrl: MOCK_BASE_URL, retryAttempts: 2 });
      const mockUser = { user_id: 1, first_name: "Bot", is_bot: true };
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: { get: () => null },
          json: async () => ({ code: "too.many.requests" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockUser,
        });

      const result = await retryApi.getMe();
      expect(result).toEqual(mockUser);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("should not retry 4xx client errors", async () => {
      const retryApi = new MaxApi({ token: MOCK_TOKEN, baseUrl: MOCK_BASE_URL, retryAttempts: 3 });
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ code: "invalid.request" }),
      });

      await expect(retryApi.getMe()).rejects.toThrow(MaxApiError);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("should NOT retry a 502 on a non-idempotent POST (duplicate-send risk)", async () => {
      const retryApi = new MaxApi({ token: MOCK_TOKEN, baseUrl: MOCK_BASE_URL, retryAttempts: 3 });
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        headers: { get: () => null },
        json: async () => ({ code: "bad.gateway" }),
      });

      await expect(retryApi.sendMessage({ text: "hi" }, { chat_id: 1 })).rejects.toThrow(MaxApiError);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("should retry a 502 on an idempotent GET", async () => {
      const retryApi = new MaxApi({ token: MOCK_TOKEN, baseUrl: MOCK_BASE_URL, retryAttempts: 2 });
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 502, headers: { get: () => null }, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ user_id: 1, first_name: "Bot", is_bot: true }) });

      await retryApi.getMe();
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("should retry 429 even on a non-idempotent POST (request was rejected)", async () => {
      const retryApi = new MaxApi({ token: MOCK_TOKEN, baseUrl: MOCK_BASE_URL, retryAttempts: 2 });
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { body: { mid: "m" }, timestamp: 1, recipient: { chat_id: 1 } } }) });

      await retryApi.sendMessage({ text: "hi" }, { chat_id: 1 });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("getUpdates never retries (polling loop owns retries)", async () => {
      const retryApi = new MaxApi({ token: MOCK_TOKEN, baseUrl: MOCK_BASE_URL, retryAttempts: 3 });
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        headers: { get: () => null },
        json: async () => ({}),
      });

      await expect(retryApi.getUpdates({ timeout: 30 })).rejects.toThrow(MaxApiError);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("should expose the MAX error code on MaxApiError", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ code: "attachment.not.ready", message: "processing" }),
      });

      const err = await api.getMe().catch((e) => e as MaxApiError);
      expect(err).toBeInstanceOf(MaxApiError);
      expect((err as MaxApiError).code).toBe("attachment.not.ready");
    });
  });

  describe("base URL", () => {
    it("should default to platform-api2.max.ru (platform-api dies 2026-07-19)", async () => {
      const defaultApi = new MaxApi({ token: MOCK_TOKEN });
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user_id: 1, first_name: "Bot", is_bot: true }),
      });

      await defaultApi.getMe();
      const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
      expect(url.startsWith("https://platform-api2.max.ru/")).toBe(true);
    });
  });

  describe("webhook subscriptions", () => {
    it("should subscribe to webhook", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await api.subscribe({
        url: "https://example.com/webhook",
        secret: "my-secret",
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/subscriptions"),
        expect.objectContaining({
          method: "POST",
        }),
      );
    });

    it("should unsubscribe from webhook", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await api.unsubscribe("https://example.com/webhook");

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/subscriptions"),
        expect.objectContaining({
          method: "DELETE",
        }),
      );
    });

    it("should get subscriptions list", async () => {
      const mockSubs = {
        subscriptions: [
          { url: "https://example.com/webhook", time: Date.now() },
        ],
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockSubs,
      });

      const result = await api.getSubscriptions();
      expect(result.subscriptions).toHaveLength(1);
    });
  });

  describe("timeout handling", () => {
    it("should abort request on timeout", async () => {
      const slowApi = new MaxApi({ token: MOCK_TOKEN, timeoutMs: 100 });

      global.fetch = vi.fn().mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(resolve, 500)),
      );

      await expect(slowApi.getMe()).rejects.toThrow();
    });
  });
});
