/**
 * Tests for MAX message actions adapter
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { maxMessageActions } from "./actions.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const actions = maxMessageActions as any;

describe("MAX Message Actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("describeMessageTool", () => {
    it("should return null when no accounts configured", () => {
      const cfg: OpenClawConfig = { channels: {} };
      const result = actions.describeMessageTool({ cfg });
      expect(result).toBeNull();
    });

    it("should return actions when account is configured", () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            enabled: true,
            botToken: "test-token",
          },
        },
      };
      const result = actions.describeMessageTool({ cfg });
      expect(result).not.toBeNull();
      expect(result?.actions).toContain("send");
      expect(result?.actions).toContain("edit");
      expect(result?.actions).toContain("delete");
    });

    it("should return null for disabled accounts", () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            enabled: false,
            botToken: "test-token",
          },
        },
      };
      const result = actions.describeMessageTool({ cfg });
      expect(result).toBeNull();
    });

    it("should return null when token is missing", () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            enabled: true,
          },
        },
      };
      const result = actions.describeMessageTool({ cfg });
      expect(result).toBeNull();
    });
  });

  describe("extractToolSend", () => {
    it("should extract send action params", () => {
      const args = {
        action: "send",
        target: "123456",
        message: "Hello",
      };
      const result = actions.extractToolSend({ args });
      expect(result).toEqual({ to: "123456", accountId: undefined });
    });

    it("should extract accountId if provided", () => {
      const args = {
        action: "send",
        target: "123456",
        accountId: "prod",
      };
      const result = actions.extractToolSend({ args });
      expect(result).toEqual({ to: "123456", accountId: "prod" });
    });

    it("should route edit/delete actions via messageId placeholder", () => {
      const args = { action: "edit", messageId: "msg-1" };
      const result = actions.extractToolSend({ args });
      expect(result).toEqual({ to: "__message_action__", accountId: undefined });
    });

    it("should return null for actions without target or messageId", () => {
      const args = { action: "edit" };
      const result = actions.extractToolSend({ args });
      expect(result).toBeNull();
    });

    it("should return null when target is missing", () => {
      const args = { action: "send", message: "Hello" };
      const result = actions.extractToolSend({ args });
      expect(result).toBeNull();
    });
  });

  describe("handleAction - send", () => {
    it("should send text message", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            botToken: "test-token",
          },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: {
            body: { mid: "msg-123", text: "Hello" },
            timestamp: Date.now(),
            recipient: { chat_id: 123 },
          },
        }),
      });

      await expect(
        actions.handleAction({
          action: "send",
          params: { target: "123", message: "Hello" },
          cfg,
        } as any),
      ).resolves.toBeDefined();
    });

    it("should throw error when token not configured", async () => {
      const cfg: OpenClawConfig = { channels: { max: {} } };
      await expect(
        actions.handleAction({
          action: "send",
          params: { target: "123", message: "Hello" },
          cfg,
        } as any),
      ).rejects.toThrow("token not configured");
    });

    it("should require target parameter", async () => {
      const cfg: OpenClawConfig = {
        channels: { max: { botToken: "token" } },
      };
      await expect(
        actions.handleAction({
          action: "send",
          params: { message: "Hello" },
          cfg,
        } as any),
      ).rejects.toThrow();
    });

    it("should require message parameter", async () => {
      const cfg: OpenClawConfig = {
        channels: { max: { botToken: "token" } },
      };
      await expect(
        actions.handleAction({
          action: "send",
          params: { target: "123" },
          cfg,
        } as any),
      ).rejects.toThrow();
    });

    it("should accept empty message text", async () => {
      const cfg: OpenClawConfig = {
        channels: { max: { botToken: "token" } },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: {
            body: { mid: "msg-empty" },
            timestamp: Date.now(),
            recipient: { chat_id: 123 },
          },
        }),
      });

      await expect(
        actions.handleAction({
          action: "send",
          params: { target: "123", message: "" },
          cfg,
        } as any),
      ).resolves.toBeDefined();
    });

    it("should send with replyTo", async () => {
      const cfg: OpenClawConfig = {
        channels: { max: { botToken: "token" } },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: {
            body: { mid: "msg-reply" },
            timestamp: Date.now(),
            recipient: { chat_id: 123 },
          },
        }),
      });

      await actions.handleAction({
        action: "send",
        params: { target: "123", message: "Reply", replyTo: "original-msg" },
        cfg,
      } as any);

      const callBody = JSON.parse(
        (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(callBody.link).toEqual({ type: "reply", mid: "original-msg" });
    });
  });

  describe("handleAction - edit", () => {
    it("should edit message", async () => {
      const cfg: OpenClawConfig = {
        channels: { max: { botToken: "token" } },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await expect(
        actions.handleAction({
          action: "edit",
          params: { messageId: "msg-123", message: "Updated" },
          cfg,
        } as any),
      ).resolves.toBeDefined();
    });

    it("should require messageId", async () => {
      const cfg: OpenClawConfig = {
        channels: { max: { botToken: "token" } },
      };

      await expect(
        actions.handleAction({
          action: "edit",
          params: { message: "Updated" },
          cfg,
        } as any),
      ).rejects.toThrow();
    });

    it("should require message text", async () => {
      const cfg: OpenClawConfig = {
        channels: { max: { botToken: "token" } },
      };

      await expect(
        actions.handleAction({
          action: "edit",
          params: { messageId: "msg-123" },
          cfg,
        } as any),
      ).rejects.toThrow();
    });
  });

  describe("handleAction - delete", () => {
    it("should delete message", async () => {
      const cfg: OpenClawConfig = {
        channels: { max: { botToken: "token" } },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await expect(
        actions.handleAction({
          action: "delete",
          params: { messageId: "msg-456" },
          cfg,
        } as any),
      ).resolves.toBeDefined();
    });

    it("should require messageId", async () => {
      const cfg: OpenClawConfig = {
        channels: { max: { botToken: "token" } },
      };

      await expect(
        actions.handleAction({
          action: "delete",
          params: {},
          cfg,
        } as any),
      ).rejects.toThrow();
    });
  });

  describe("handleAction - unsupported", () => {
    it("should throw error for unsupported action", async () => {
      const cfg: OpenClawConfig = {
        channels: { max: { botToken: "token" } },
      };

      await expect(
        actions.handleAction({
          action: "unsupported" as never,
          params: {},
          cfg,
        } as any),
      ).rejects.toThrow("not supported");
    });
  });

  describe("account resolution", () => {
    it("should use specified accountId", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            botToken: "default-token",
            accounts: {
              prod: { botToken: "prod-token" },
            },
          },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: {
            body: { mid: "msg-prod" },
            timestamp: Date.now(),
            recipient: { chat_id: 123 },
          },
        }),
      });

      await actions.handleAction({
        action: "send",
        params: { target: "123", message: "Test" },
        cfg,
        accountId: "prod",
      } as any);

      // Verify token used in Authorization header
      const authHeader = (global.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0][1].headers.Authorization;
      expect(authHeader).toBe("prod-token");
    });
  });
});