/**
 * Tests for persistent MAX state (polling marker + chat registry)
 */

import { describe, it, expect } from "vitest";
import { MaxStateStore, loadMaxAccountState, resolveMaxStatePath } from "./state.js";

describe("MaxStateStore", () => {
  it("should persist the polling marker across store instances", async () => {
    const store = new MaxStateStore("test-marker");
    await store.load();
    store.setMarker(123456);
    await store.flush();

    const reloaded = new MaxStateStore("test-marker");
    const state = await reloaded.load();
    expect(state.marker).toBe(123456);
  });

  it("should keep a chat registry with add/remove lifecycle", async () => {
    const store = new MaxStateStore("test-registry");
    await store.load();

    store.upsertChat(100, { type: "chat", title: "Рабочая группа", addedAt: 1 });
    store.upsertChat(200, { type: "channel", addedAt: 2 });
    store.upsertChat(100, { title: "Переименованная группа" });
    store.upsertChat(200, { removedAt: 3 });
    await store.flush();

    const state = await loadMaxAccountState("test-registry");
    expect(state.chats?.["100"]).toMatchObject({
      chatId: 100,
      type: "chat",
      title: "Переименованная группа",
    });
    expect(state.chats?.["100"].removedAt).toBeUndefined();
    expect(state.chats?.["200"].removedAt).toBe(3);
    expect(store.hasChat(100)).toBe(true);
    expect(store.hasChat(999)).toBe(false);
  });

  it("should clear removedAt when a chat is re-added", async () => {
    const store = new MaxStateStore("test-readd");
    await store.load();

    store.upsertChat(300, { type: "chat", addedAt: 1 });
    store.upsertChat(300, { removedAt: 2 });
    store.upsertChat(300, { type: "chat", addedAt: 3 });
    await store.flush();

    const state = await loadMaxAccountState("test-readd");
    expect(state.chats?.["300"].removedAt).toBeUndefined();
    expect(state.chats?.["300"].addedAt).toBe(3);
  });

  it("hasActiveChat distinguishes removed chats (so a re-added chat is re-registered)", async () => {
    const store = new MaxStateStore("test-active");
    await store.load();

    store.upsertChat(400, { type: "chat", addedAt: 1 });
    expect(store.hasActiveChat(400)).toBe(true);
    expect(store.hasChat(400)).toBe(true);

    store.upsertChat(400, { removedAt: 2 });
    // still known, but no longer active — the message_created guard must re-register it
    expect(store.hasChat(400)).toBe(true);
    expect(store.hasActiveChat(400)).toBe(false);

    expect(store.hasActiveChat(999)).toBe(false);
  });

  it("should sanitize account ids in state paths", () => {
    const p = resolveMaxStatePath("../../evil/../id");
    expect(p).not.toContain("..");
    expect(p).toContain("state-");
  });
});
