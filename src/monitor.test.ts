/**
 * Tests for MAX monitor (interface verification)
 */

import { describe, it, expect, vi } from "vitest";
import { startMaxPolling, MAX_SUBSCRIBED_UPDATE_TYPES, createSerializedWebhookHandler } from "./monitor.js";
import type { MaxUpdate } from "./api.js";

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
