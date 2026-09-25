/**
 * Tests for MAX monitor (interface verification)
 */

import { describe, it, expect, vi } from "vitest";
import { startMaxPolling, MAX_SUBSCRIBED_UPDATE_TYPES, createSerializedWebhookHandler } from "./monitor.js";
import type { MaxMessage, MaxUpdate } from "./api.js";

function makeMsgUpdate(chatId: number, mid: string): MaxUpdate {
  return {
    update_type: "message_created",
    timestamp: 1,
    message: { body: { mid }, timestamp: 1, recipient: { chat_id: chatId } },
  } as MaxUpdate;
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("MAX Monitor", () => {
  describe("startMaxPolling", () => {
    it("should be a function", () => {
      expect(typeof startMaxPolling).toBe("function");
    });

    it("should accept correct parameters", () => {
      // Interface test - verify function signature
      expect(startMaxPolling.length).toBe(1); // Single options object
    });
  });

  // Full integration tests for monitor would require:
  // - Mock PluginRuntime
  // - Mock MaxApi.getUpdates with long-polling simulation
  // - Mock inbound dispatch pipeline
  // These are better suited for E2E tests rather than unit tests.
});

describe("createSerializedWebhookHandler", () => {
  it("acks immediately (resolves before dispatch completes)", async () => {
    const gate = deferred();
    const dispatch = vi.fn().mockImplementation(() => gate.promise);
    const handler = createSerializedWebhookHandler({
      dispatch,
      abortSignal: new AbortController().signal,
      onError: () => {},
    });

    let acked = false;
    await handler(makeMsgUpdate(1, "m1")).then(() => { acked = true; });
    expect(acked).toBe(true); // ack returned before dispatch resolved
    expect(dispatch).toHaveBeenCalledTimes(1);
    gate.resolve();
  });

  it("serializes updates within one chat (no overlap)", async () => {
    const order: string[] = [];
    const g1 = deferred();
    const dispatch = vi.fn().mockImplementation(async (u: MaxUpdate) => {
      order.push(`start:${u.message?.body?.mid}`);
      if (u.message?.body?.mid === "a") await g1.promise;
      order.push(`end:${u.message?.body?.mid}`);
    });
    const handler = createSerializedWebhookHandler({
      dispatch,
      abortSignal: new AbortController().signal,
      onError: () => {},
    });

    await handler(makeMsgUpdate(1, "a"));
    await handler(makeMsgUpdate(1, "b"));
    await Promise.resolve();
    // b must not start until a ends
    expect(order).toEqual(["start:a"]);
    g1.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("does not block a second chat behind a slow first chat (no cross-chat HOL)", async () => {
    const started: string[] = [];
    const gA = deferred();
    const dispatch = vi.fn().mockImplementation(async (u: MaxUpdate) => {
      started.push(String(u.message?.recipient?.chat_id));
      if (u.message?.recipient?.chat_id === 1) await gA.promise;
    });
    const handler = createSerializedWebhookHandler({
      dispatch,
      abortSignal: new AbortController().signal,
      onError: () => {},
    });

    await handler(makeMsgUpdate(1, "slow"));
    await handler(makeMsgUpdate(2, "fast"));
    await new Promise((r) => setTimeout(r, 10));
    // chat 2 ran even though chat 1 is still blocked
    expect(started).toContain("2");
    gA.resolve();
  });

  it("stops dispatching queued updates after abort", async () => {
    const controller = new AbortController();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const handler = createSerializedWebhookHandler({
      dispatch,
      abortSignal: controller.signal,
      onError: () => {},
    });

    controller.abort();
    await handler(makeMsgUpdate(1, "x"));
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps the chain alive after a dispatch error", async () => {
    const onError = vi.fn();
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const handler = createSerializedWebhookHandler({
      dispatch,
      abortSignal: new AbortController().signal,
      onError,
    });

    await handler(makeMsgUpdate(1, "bad"));
    await handler(makeMsgUpdate(1, "good"));
    await new Promise((r) => setTimeout(r, 10));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

describe("MAX_SUBSCRIBED_UPDATE_TYPES", () => {
  it("should not request update types that do not exist in the API", () => {
    // Reactions never existed in MAX Bot API; a stricter server-side enum
    // validation would 400 the whole polling loop.
    expect(MAX_SUBSCRIBED_UPDATE_TYPES).not.toContain("message_reaction_created");
    expect(MAX_SUBSCRIBED_UPDATE_TYPES).not.toContain("message_reaction_updated");
  });

  it("should include the lifecycle events added to the API in 2026", () => {
    expect(MAX_SUBSCRIBED_UPDATE_TYPES).toContain("bot_stopped");
    expect(MAX_SUBSCRIBED_UPDATE_TYPES).toContain("dialog_cleared");
    expect(MAX_SUBSCRIBED_UPDATE_TYPES).toContain("dialog_removed");
    expect(MAX_SUBSCRIBED_UPDATE_TYPES).toContain("chat_title_changed");
    expect(MAX_SUBSCRIBED_UPDATE_TYPES).toContain("message_chat_created");
  });
});

describe("processIncomingMessage inbound media", () => {
  it("passes downloaded attachments to the agent as ordered media facts", async () => {
    const { finalizeInboundContext } = await import("openclaw/plugin-sdk/reply-dispatch-runtime");
    const { setMaxRuntime } = await import("./runtime.js");
    const { processIncomingMessage } = await import("./monitor.js");

    const saved = [
      { path: "/state/media/inbound/photo-1.jpg", contentType: "image/jpeg" },
      { path: "/state/media/inbound/doc-2.bin", contentType: undefined },
    ];
    let saveIndex = 0;
    let dispatchedCtx: Record<string, unknown> | undefined;
    let finalizeInput: Record<string, unknown> | undefined;
    const core = {
      channel: {
        media: {
          fetchRemoteMedia: vi.fn(async ({ url }: { url: string }) => ({
            buffer: Buffer.from(url),
            contentType: "application/octet-stream",
            fileName: url.endsWith("doc") ? "report.pdf" : undefined,
          })),
          saveMediaBuffer: vi.fn(async () => saved[saveIndex++]),
        },
        routing: {
          resolveAgentRoute: vi.fn(() => ({ agentId: "main", accountId: "default", sessionKey: "agent:main:max:direct:7" })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/tmp/store"),
          readSessionUpdatedAt: vi.fn(() => undefined),
          recordSessionMetaFromInbound: vi.fn(async () => undefined),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({})),
          formatAgentEnvelope: vi.fn(({ body }: { body: string }) => body),
          finalizeInboundContext: (ctx: Record<string, unknown>) => {
            finalizeInput = { ...ctx };
            return finalizeInboundContext(ctx);
          },
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async ({ ctx }: { ctx: Record<string, unknown> }) => {
            dispatchedCtx = ctx;
          }),
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setMaxRuntime(core as any);

    await processIncomingMessage(
      {
        sender: { user_id: 7, first_name: "Ann", is_bot: false },
        recipient: { chat_id: 70, chat_type: "dialog" },
        timestamp: 1,
        body: {
          mid: "mid.media",
          text: "look",
          attachments: [
            { type: "image", payload: { url: "https://cdn.max.test/photo" } },
            { type: "file", payload: { url: "https://cdn.max.test/doc" }, filename: "report.pdf" },
          ],
        },
      } as unknown as MaxMessage,
      null,
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        api: { sendAction: vi.fn(async () => ({ success: true })) } as any,
        account: {
          accountId: "default",
          enabled: true,
          token: "t",
          tokenSource: "config",
          config: { dmPolicy: "open" },
        },
        config: { channels: {} },
        abortSignal: new AbortController().signal,
      },
    );

    expect(dispatchedCtx).toBeDefined();
    expect(dispatchedCtx?.media).toEqual([
      expect.objectContaining({ path: saved[0].path, contentType: "image/jpeg", messageId: "mid.media" }),
      expect.objectContaining({ path: saved[1].path, fileName: "report.pdf", messageId: "mid.media" }),
    ]);
    // Signed CDN URLs never reach the agent context.
    expect(JSON.stringify(dispatchedCtx?.media)).not.toContain("cdn.max.test");
    // The plugin hands over only `media`; any legacy Media* projection is the SDK's.
    for (const key of ["MediaPath", "MediaPaths", "MediaUrl", "MediaUrls", "MediaType", "MediaTypes"]) {
      expect(finalizeInput).not.toHaveProperty(key);
    }
    // The agent still sees the local file path of the first attachment.
    expect(dispatchedCtx?.MediaPath ?? (dispatchedCtx?.media as { path?: string }[])[0]?.path).toBe(saved[0].path);
  });
});
