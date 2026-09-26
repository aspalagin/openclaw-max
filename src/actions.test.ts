/**
 * Tests for MAX message actions adapter
 */

import { mkdtemp, rm, writeFile } from "fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach,describe, expect, it, vi } from "vitest";

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

    it("should extract chatId when target is absent", () => {
      const args = {
        action: "send",
        chatId: "max:123456",
        message: "Hello",
      };
      const result = actions.extractToolSend({ args });
      expect(result).toEqual({ to: "123456", accountId: undefined });
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
        } as never),
      ).resolves.toBeDefined();
    });

    it("should throw error when token not configured", async () => {
      const cfg: OpenClawConfig = { channels: { max: {} } };
      await expect(
        actions.handleAction({
          action: "send",
          params: { target: "123", message: "Hello" },
          cfg,
        } as never),
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
        } as never),
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
        } as never),
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
        } as never),
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
      } as never);

      const callBody = JSON.parse(
        (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(callBody.link).toEqual({ type: "reply", mid: "original-msg" });
    });
  });

  describe("handleAction - send parsing", () => {
    const cfg: OpenClawConfig = { channels: { max: { botToken: "test-token" } } };
    const okResponse = () => ({
      ok: true,
      json: async () => ({
        message: { body: { mid: "mid-1" }, timestamp: Date.now(), recipient: { chat_id: 123 } },
      }),
    });
    const sentBody = (fetchMock: ReturnType<typeof vi.fn>) =>
      JSON.parse(String(fetchMock.mock.calls[0][1].body));

    it("parses tool buttons with the channelData parser (label, types, callback_data, web_app)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(okResponse());
      global.fetch = fetchMock;
      await actions.handleAction({
        action: "send",
        params: {
          target: "123",
          message: "Выбор",
          buttons: [
            [{ label: "Да", callback_data: "yes" }, { text: "Сайт", url: "https://example.org" }],
            { text: "Копия", type: "clipboard", callback_data: "code-1" },
            [{ text: "App", type: "open_app", web_app: "mini_bot" }, null, { text: "" }],
          ],
        },
        cfg,
      } as never);
      expect(sentBody(fetchMock).attachments[0].payload.buttons).toEqual([
        [
          { type: "callback", text: "Да", payload: "yes" },
          { type: "link", text: "Сайт", url: "https://example.org" },
        ],
        [{ type: "clipboard", text: "Копия", payload: "code-1" }],
        [{ type: "open_app", text: "App", web_app: "mini_bot" }],
      ]);
    });

    it("sends a location from latitude/longitude or a LAT,LNG string", async () => {
      const fetchMock = vi.fn().mockResolvedValue(okResponse());
      global.fetch = fetchMock;
      await actions.handleAction({
        action: "send",
        params: { target: "123", message: "", location: "55.75, 37.62" },
        cfg,
      } as never);
      await actions.handleAction({
        action: "sendAttachment",
        params: { target: "123", type: "location", latitude: "59.93", longitude: 30.31 },
        cfg,
      } as never);
      const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1].body)));
      expect(bodies[0].attachments).toEqual([{ type: "location", latitude: 55.75, longitude: 37.62 }]);
      expect(bodies[1].attachments).toEqual([{ type: "location", latitude: 59.93, longitude: 30.31 }]);
    });

    it("rejects sendAttachment location without usable coordinates", async () => {
      global.fetch = vi.fn().mockResolvedValue(okResponse());
      await expect(actions.handleAction({
        action: "sendAttachment",
        params: { target: "123", type: "location", location: "north" },
        cfg,
      } as never)).rejects.toThrow("Invalid location");
    });

    it("sends a contact card from contactName with contactId or phone", async () => {
      const fetchMock = vi.fn().mockResolvedValue(okResponse());
      global.fetch = fetchMock;
      await actions.handleAction({
        action: "send",
        params: { target: "123", message: "", contactName: "Иван", contactId: "42", phone: "+70001234567" },
        cfg,
      } as never);
      await actions.handleAction({
        action: "sendAttachment",
        params: { target: "123", type: "contact", name: "Пётр", vcfPhone: "+70007654321" },
        cfg,
      } as never);
      const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1].body)));
      expect(bodies[0].attachments[0].payload).toEqual({ name: "Иван", contact_id: 42, vcf_phone: "+70001234567" });
      expect(bodies[1].attachments[0].payload).toEqual({
        name: "Пётр",
        vcf_info: "BEGIN:VCARD\nVERSION:3.0\nFN:Пётр\nTEL:+70007654321\nEND:VCARD",
      });
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
        } as never),
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
        } as never),
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
        } as never),
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
        } as never),
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
        } as never),
      ).rejects.toThrow();
    });
  });

  describe("handleAction - sendAttachment", () => {
    it("should send media attachments through the upload flow", async () => {
      const cfg: OpenClawConfig = {
        channels: { max: { botToken: "token" } },
      };
      const tempDir = await mkdtemp(join(tmpdir(), "max-action-test-"));
      const mediaPath = join(tempDir, "clip.mp4");
      await writeFile(mediaPath, Buffer.from("fake-video"));

      try {
        global.fetch = vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ url: "https://upload.max.ru/token", token: "upload-token" }),
          })
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({}),
          })
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              message: {
                body: { mid: "msg-media" },
                timestamp: Date.now(),
                recipient: { chat_id: 123 },
              },
            }),
          });

        await expect(
          actions.handleAction({
            action: "sendAttachment",
            params: { chatId: "max:123", media: mediaPath, filename: "clip.mp4", caption: "Video" },
            cfg,
          } as never),
        ).resolves.toBeDefined();

        expect(global.fetch).toHaveBeenCalledTimes(3);
        const sendCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[2];
        const sendUrl = sendCall[0] as string;
        const sendBody = JSON.parse(sendCall[1].body as string);
        expect(sendUrl).toContain("/messages");
        expect(sendUrl).toContain("chat_id=123");
        expect(sendBody.text).toBe("Video");
        expect(sendBody.attachments).toEqual([
          { type: "video", payload: { token: "upload-token" } },
        ]);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
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
        } as never),
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
      } as never);

      // Verify token used in Authorization header
      const authHeader = (global.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0][1].headers.Authorization;
      expect(authHeader).toBe("prod-token");
    });
  });
});
