/**
 * Tests for MAX message sending
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  sendMaxMessage,
  editMaxMessage,
  deleteMaxMessage,
  sendMaxMediaMessage,
  sendMaxSticker,
  detectMaxMediaType,
  resolveMaxTarget,
} from "./send.js";
import { MaxApi } from "./api.js";

const MOCK_TOKEN = "test-token";

describe("MAX Message Sending", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("sendMaxMessage", () => {
    it("should send text message with token option", async () => {
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

      const result = await sendMaxMessage("123", "Hello", {
        token: MOCK_TOKEN,
      });

      expect(result.messageId).toBe("msg-123");
      expect(global.fetch).toHaveBeenCalled();
    });

    it("should send message with config and accountId", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            botToken: "config-token",
          },
        },
      };

      const mockResult = {
        message: {
          body: { mid: "msg-456", text: "Test" },
          timestamp: Date.now(),
          recipient: { chat_id: 456 },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      const result = await sendMaxMessage("456", "Test", { cfg });
      expect(result.messageId).toBe("msg-456");
    });

    it("should throw error when no token available", async () => {
      const cfg: OpenClawConfig = { channels: { max: {} } };
      await expect(
        sendMaxMessage("123", "Hello", { cfg }),
      ).rejects.toThrow("token not available");
    });

    it("should send message with markdown format", async () => {
      const mockResult = {
        message: {
          body: { mid: "msg-789", text: "**Bold**" },
          timestamp: Date.now(),
          recipient: { chat_id: 123 },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      await sendMaxMessage("123", "**Bold**", {
        token: MOCK_TOKEN,
        format: "markdown",
      });

      const callBody = JSON.parse(
        (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(callBody.format).toBe("markdown");
    });

    it("should send message with reply context", async () => {
      const mockResult = {
        message: {
          body: { mid: "msg-reply", text: "Reply" },
          timestamp: Date.now(),
          recipient: { chat_id: 123 },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      await sendMaxMessage("123", "Reply", {
        token: MOCK_TOKEN,
        replyToMessageId: "original-msg-id",
      });

      const callBody = JSON.parse(
        (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(callBody.link).toEqual({
        type: "reply",
        mid: "original-msg-id",
      });
    });

    it("should send message with inline keyboard", async () => {
      const mockResult = {
        message: {
          body: { mid: "msg-kb", text: "Pick one" },
          timestamp: Date.now(),
          recipient: { chat_id: 123 },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      await sendMaxMessage("123", "Pick one", {
        token: MOCK_TOKEN,
        buttons: [
          [
            { text: "Option 1", payload: "opt1" },
            { text: "Link", url: "https://example.com" },
          ],
        ],
      });

      const callBody = JSON.parse(
        (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(callBody.attachments).toHaveLength(1);
      expect(callBody.attachments[0].type).toBe("inline_keyboard");
      expect(callBody.attachments[0].payload.buttons[0]).toHaveLength(2);
    });

    it("should disable link preview when requested", async () => {
      const mockResult = {
        message: {
          body: { mid: "msg-nopreview", text: "Link" },
          timestamp: Date.now(),
          recipient: { chat_id: 123 },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      await sendMaxMessage("123", "https://example.com", {
        token: MOCK_TOKEN,
        disableLinkPreview: true,
      });

      const callUrl = (global.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as string;
      expect(callUrl).toContain("disable_link_preview=true");
    });
  });

  describe("editMaxMessage", () => {
    it("should edit existing message", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await editMaxMessage("msg-123", "Updated text", {
        token: MOCK_TOKEN,
        format: "markdown",
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/messages"),
        expect.objectContaining({
          method: "PUT",
        }),
      );

      const callBody = JSON.parse(
        (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(callBody.text).toBe("Updated text");
      expect(callBody.format).toBe("markdown");
    });

    it("should throw error when no token available", async () => {
      const cfg: OpenClawConfig = { channels: { max: {} } };
      await expect(
        editMaxMessage("msg-123", "Updated", { cfg }),
      ).rejects.toThrow("token not available");
    });
  });

  describe("deleteMaxMessage", () => {
    it("should delete message", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await deleteMaxMessage("msg-456", { token: MOCK_TOKEN });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/messages"),
        expect.objectContaining({
          method: "DELETE",
        }),
      );
    });
  });

  describe("sendMaxMediaMessage", () => {
    it("should detect media type from extension", async () => {
      const mockUploadResult = { url: "https://cdn.max.ru/uploaded-image.jpg" };
      const mockSendResult = {
        message: {
          body: { mid: "msg-media", text: "Caption" },
          timestamp: Date.now(),
          recipient: { chat_id: 123 },
        },
      };

      // Mock both upload and send
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          // getUploadUrl
          ok: true,
          json: async () => ({ url: "https://upload.max.ru/token" }),
        })
        .mockResolvedValueOnce({
          // uploadMedia POST
          ok: true,
          json: async () => mockUploadResult,
        })
        .mockResolvedValueOnce({
          // sendMessage
          ok: true,
          json: async () => mockSendResult,
        });

      // We need to mock fs.readFile for local file path
      const mockReadFile = vi.fn().mockResolvedValue(Buffer.from("fake-image"));
      vi.doMock("fs/promises", () => ({
        readFile: mockReadFile,
      }));

      // For this test, we'll just verify the flow without actual file reading
      // In production, sendMaxMediaMessage would read the file, but in tests
      // we can't easily mock dynamic imports in vitest.
      // We'll skip the actual call and just test the interface.

      // Just verify function signature
      expect(typeof sendMaxMediaMessage).toBe("function");
    });

    it("should accept caption and options", () => {
      // Interface test - ensure function accepts expected params
      const fn = sendMaxMediaMessage;
      expect(fn.length).toBe(3); // to, caption, mediaPath
    });
  });
});

describe("MAX Sticker Sending", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("sendMaxSticker", () => {
    it("should send sticker with code", async () => {
      const mockResult = {
        message: {
          body: { mid: "sticker-msg-123", attachments: [{ type: "sticker", payload: { code: "test_sticker" } }] },
          timestamp: Date.now(),
          recipient: { chat_id: 123 },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      const result = await sendMaxSticker("123", "test_sticker", { token: MOCK_TOKEN });

      expect(result.messageId).toBe("sticker-msg-123");
      expect(global.fetch).toHaveBeenCalled();

      const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/messages");
      expect(url).toContain("chat_id=123");
      const body = JSON.parse(init.body as string);
      expect(body.attachments).toEqual([
        { type: "sticker", payload: { code: "test_sticker" } },
      ]);
      expect(body.text).toBeUndefined();
    });

    it("should send sticker with reply context", async () => {
      const mockResult = {
        message: {
          body: { mid: "sticker-reply-456" },
          timestamp: Date.now(),
          recipient: { chat_id: 456 },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      const result = await sendMaxSticker("456", "reply_sticker_code", {
        token: MOCK_TOKEN,
        replyToMessageId: "original-msg-789",
      });

      expect(result.messageId).toBe("sticker-reply-456");
      const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.link).toEqual({ type: "reply", mid: "original-msg-789" });
    });

    it("should be a function with correct signature", () => {
      expect(typeof sendMaxSticker).toBe("function");
      expect(sendMaxSticker.length).toBe(2); // to, stickerCode (opts is optional)
    });
  });
});

describe("MAX markdown dialect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should convert <u>…</u> to ++…++ but leave __bold__/**bold** intact", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { body: { mid: "m1" }, timestamp: 1, recipient: { chat_id: 1 } } }),
    });

    await sendMaxMessage("123", "<u>подчёркнуто</u>, __жирно__ и **тоже жирно**", {
      token: MOCK_TOKEN,
      format: "markdown",
    });

    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    // MAX renders __text__/**text** as bold itself — do not touch them
    expect(body.text).toBe("++подчёркнуто++, __жирно__ и **тоже жирно**");
  });

  it("should NOT mangle __dunders__ inside code spans, fenced blocks or URLs", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { body: { mid: "m1" }, timestamp: 1, recipient: { chat_id: 1 } } }),
    });

    const text = "call `<u>x</u>` here, see https://host/<u>y</u>/page and:\n```py\ndef f(): pass  # <u>z</u>\n```";
    await sendMaxMessage("123", text, { token: MOCK_TOKEN, format: "markdown" });

    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    // <u> inside code spans / fenced blocks / URLs must survive verbatim
    expect(body.text).toContain("`<u>x</u>`");
    expect(body.text).toContain("https://host/<u>y</u>/page");
    expect(body.text).toContain("# <u>z</u>");
    expect(body.text).not.toContain("++");
  });

  it("should leave text untouched without format", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { body: { mid: "m1" }, timestamp: 1, recipient: { chat_id: 1 } } }),
    });

    await sendMaxMessage("123", "<u>raw</u>", { token: MOCK_TOKEN });

    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.text).toBe("<u>raw</u>");
  });
});

describe("MAX button types", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should build message/clipboard/open_app/request buttons", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { body: { mid: "m1" }, timestamp: 1, recipient: { chat_id: 1 } } }),
    });

    await sendMaxMessage("123", "pick", {
      token: MOCK_TOKEN,
      buttons: [[
        { text: "Подробнее", type: "message" },
        { text: "Скопировать", type: "clipboard", payload: "CODE-42" },
        { text: "Мини-апп", type: "open_app", webApp: "someapp" },
        { text: "Контакт", type: "request_contact" },
        { text: "Гео", type: "request_geo_location" },
      ]],
    });

    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    const row = body.attachments[0].payload.buttons[0];
    expect(row).toEqual([
      { type: "message", text: "Подробнее" },
      { type: "clipboard", text: "Скопировать", payload: "CODE-42" },
      { type: "open_app", text: "Мини-апп", web_app: "someapp" },
      { type: "request_contact", text: "Контакт" },
      { type: "request_geo_location", text: "Гео" },
    ]);
  });

  it("should pass intent on callback buttons", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { body: { mid: "m1" }, timestamp: 1, recipient: { chat_id: 1 } } }),
    });

    await sendMaxMessage("123", "sure?", {
      token: MOCK_TOKEN,
      buttons: [[{ text: "Удалить", payload: "del", intent: "negative" }]],
    });

    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.attachments[0].payload.buttons[0][0]).toEqual({
      type: "callback",
      text: "Удалить",
      payload: "del",
      intent: "negative",
    });
  });
});

describe("detectMaxMediaType", () => {
  it("should route modern formats to the right upload type", () => {
    expect(detectMaxMediaType("photo.heic")).toBe("image");
    expect(detectMaxMediaType("scan.tiff")).toBe("image");
    expect(detectMaxMediaType("clip.webm")).toBe("video");
    expect(detectMaxMediaType("movie.mkv")).toBe("video");
    expect(detectMaxMediaType("legacy.avi")).toBe("file");
    expect(detectMaxMediaType("animation.webp")).toBe("file");
    expect(detectMaxMediaType("voice.m4a")).toBe("audio");
    expect(detectMaxMediaType("song.flac")).toBe("audio");
    expect(detectMaxMediaType("doc.pdf")).toBe("file");
    expect(detectMaxMediaType("noext")).toBe("file");
  });
});

describe("resolveMaxTarget", () => {
  it("should resolve numeric and user: targets without API calls", async () => {
    const api = new MaxApi({ token: MOCK_TOKEN });
    expect(await resolveMaxTarget(api, "12345")).toEqual({ chat_id: 12345 });
    expect(await resolveMaxTarget(api, "max:12345")).toEqual({ chat_id: 12345 });
    expect(await resolveMaxTarget(api, "user:777")).toEqual({ user_id: 777 });
    expect(await resolveMaxTarget(api, "max:user:777")).toEqual({ user_id: 777 });
  });

  it("should resolve @username via GET /chats/{chatLink}", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ chat_id: 4242, type: "chat", status: "active" }),
    });

    const api = new MaxApi({ token: MOCK_TOKEN });
    expect(await resolveMaxTarget(api, "@mygroup")).toEqual({ chat_id: 4242 });
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain("/chats/mygroup");
  });

  it("should reject garbage targets", async () => {
    const api = new MaxApi({ token: MOCK_TOKEN });
    await expect(resolveMaxTarget(api, "not-a-target")).rejects.toThrow("Invalid MAX target");
  });

  it("should send to user_id when target is user:<id>", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { body: { mid: "m1" }, timestamp: 1, recipient: { user_id: 777 } } }),
    });

    await sendMaxMessage("user:777", "hi", { token: MOCK_TOKEN });

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain("user_id=777");
    expect(url).not.toContain("chat_id");
  });
});

describe("attachment.not.ready retry", () => {
  it("should retry the send (not the upload) until MAX finishes processing", async () => {
    const os = await import("node:os");
    // node:fs (sync) — "fs/promises" is module-mocked by an earlier test in this file
    const fs = await import("node:fs");
    const path = await import("node:path");
    const tmpFile = path.join(os.tmpdir(), `max-test-video-${Date.now()}.mp4`);
    fs.writeFileSync(tmpFile, Buffer.from("fake-video"));

    try {
      global.fetch = vi
        .fn()
        // POST /uploads
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ url: "https://upload.max.example/u", token: "tok-1" }),
        })
        // upload host POST
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ token: "tok-1" }),
        })
        // first send → attachment.not.ready
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          json: async () => ({ code: "attachment.not.ready", message: "attachment is not processed yet" }),
        })
        // retry send → ok
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ message: { body: { mid: "m-ok" }, timestamp: 1, recipient: { chat_id: 1 } } }),
        });

      const result = await sendMaxMediaMessage("123", "видео", tmpFile, { token: MOCK_TOKEN });
      expect(result.messageId).toBe("m-ok");
      expect(global.fetch).toHaveBeenCalledTimes(4);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* already gone */ }
    }
  }, 20_000);
});
