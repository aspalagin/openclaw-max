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
    // Not an Update type in the published schema (max-messenger/api-schema).
    expect(MAX_SUBSCRIBED_UPDATE_TYPES).not.toContain("message_chat_created");
  });

  it("should only request update types from the schema's Update discriminator", () => {
    // Update.discriminator.mapping in max-messenger/api-schema schema.yaml (2026-09)
    const schemaUpdateTypes = new Set([
      "message_created", "message_callback", "message_edited", "message_removed",
      "comment_created", "comment_edited", "comment_removed",
      "bot_added", "bot_removed", "user_added", "user_removed",
      "bot_started", "bot_stopped", "dialog_cleared", "dialog_removed",
      "dialog_muted", "dialog_unmuted", "chat_title_changed", "bot_admin_permissions_changed",
    ]);
    for (const type of MAX_SUBSCRIBED_UPDATE_TYPES) {
      expect(schemaUpdateTypes.has(type), type).toBe(true);
    }
  });

  it("should include the lifecycle events added to the API in 2026", () => {
    expect(MAX_SUBSCRIBED_UPDATE_TYPES).toContain("bot_stopped");
    expect(MAX_SUBSCRIBED_UPDATE_TYPES).toContain("dialog_cleared");
    expect(MAX_SUBSCRIBED_UPDATE_TYPES).toContain("dialog_removed");
    expect(MAX_SUBSCRIBED_UPDATE_TYPES).toContain("chat_title_changed");
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

  async function runVoiceMessage(audio: Record<string, unknown>) {
    const { setMaxRuntime } = await import("./runtime.js");
    const { processIncomingMessage } = await import("./monitor.js");
    const { core, dispatched } = makeCallbackRuntime();
    const fetchRemoteMedia = vi.fn(async () => ({ buffer: Buffer.from("ogg"), contentType: "audio/ogg" }));
    const runtime = {
      ...core,
      channel: {
        ...core.channel,
        media: {
          fetchRemoteMedia,
          saveMediaBuffer: vi.fn(async () => ({ path: "/state/media/inbound/voice.ogg", contentType: "audio/ogg" })),
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setMaxRuntime(runtime as any);
    await processIncomingMessage(
      {
        sender: { user_id: 7, first_name: "Ann", is_bot: false },
        recipient: { chat_id: 70, chat_type: "dialog" },
        timestamp: 1,
        body: { mid: "mid.voice", text: "", attachments: [audio] },
      } as unknown as MaxMessage,
      null,
      makeCallbackOpts({ dmPolicy: "open" }),
    );
    return { ctx: dispatched[0], fetchRemoteMedia };
  }

  it("hands a MAX voice transcription to the agent and marks the audio transcribed", async () => {
    // AudioAttachment: transcription is a sibling of payload (schema.yaml).
    const { ctx, fetchRemoteMedia } = await runVoiceMessage({
      type: "audio",
      payload: { url: "https://cdn.max.test/voice", token: "tok" },
      transcription: "  Привет, это голосовое  ",
    });

    expect(fetchRemoteMedia).toHaveBeenCalledOnce();
    expect(ctx?.BodyForAgent).toBe("[Voice transcript: Привет, это голосовое]");
    expect(ctx?.media).toEqual([
      expect.objectContaining({ path: "/state/media/inbound/voice.ogg", transcribed: true }),
    ]);
  });

  it("leaves an untranscribed voice message to core STT", async () => {
    for (const transcription of [undefined, null, "   "]) {
      const { ctx, fetchRemoteMedia } = await runVoiceMessage({
        type: "audio",
        payload: { url: "https://cdn.max.test/voice" },
        transcription,
      });

      expect(fetchRemoteMedia).toHaveBeenCalledOnce();
      expect(String(ctx?.BodyForAgent ?? "")).not.toContain("Voice transcript");
      expect((ctx?.media as { transcribed?: boolean }[])[0]?.transcribed).not.toBe(true);
    }
  });
});

// Raw `message_callback` update captured live on 2026-09-26 (names/usernames
// neutralized). `message` is a sibling of `callback`, not nested in it.
const LIVE_MESSAGE_CALLBACK = {
  callback: {
    timestamp: 1790372541327,
    callback_id: "f9LHodD0cOIcE0GTHf8RdfJDkzGZdg6GFHBI3eVxF-WDgGebGQjICTeb13K9VXDTSAxWIX9unc3bYj__sVyQ2AhBa3jV9ItunfosDJPY084qccjSZiQo",
    user: { user_id: 4260364, first_name: "User", is_bot: false, last_name: "", last_activity_time: 1790372539000, name: "User" },
    payload: "live-callback-test",
  },
  timestamp: 1790372541327,
  message: {
    recipient: { chat_type: "dialog", chat_id: 242316535, user_id: 4260364 },
    timestamp: 1790372383780,
    body: {
      mid: "mid.000000000e7174f701a0da828c245855",
      seq: 117333844543428693,
      text: "Live-тест 3: нажми кнопку",
      attachments: [
        {
          payload: { buttons: [[{ payload: "live-callback-test", text: "Нажми меня", type: "callback" }]] },
          type: "inline_keyboard",
        },
      ],
    },
    sender: { user_id: 238057211, first_name: "Bot", is_bot: true, username: "test_bot", last_activity_time: 1790372542172, name: "Bot" },
  },
  user_locale: "ru",
  update_type: "message_callback",
} as const;

function makeCallbackRuntime() {
  const dispatched: Record<string, unknown>[] = [];
  const core = {
    channel: {
      pairing: { readAllowFromStore: vi.fn(async () => []) },
      routing: {
        resolveAgentRoute: vi.fn(({ peer }: { peer: { kind: string; id: string } }) => ({
          agentId: "main",
          accountId: "default",
          sessionKey: `agent:main:max:${peer.kind}:${peer.id}`,
        })),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/store"),
        readSessionUpdatedAt: vi.fn(() => undefined),
        recordSessionMetaFromInbound: vi.fn(async () => undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        formatAgentEnvelope: vi.fn(({ body }: { body: string }) => body),
        finalizeInboundContext: (ctx: Record<string, unknown>) => ctx,
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(async ({ ctx }: { ctx: Record<string, unknown> }) => {
          dispatched.push(ctx);
        }),
      },
    },
  };
  return { core, dispatched };
}

function makeCallbackOpts(accountConfig: Record<string, unknown>) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api: { sendAction: vi.fn(async () => ({ success: true })) } as any,
    account: {
      accountId: "default",
      enabled: true,
      token: "t",
      tokenSource: "config" as const,
      config: accountConfig,
    },
    config: { channels: {} },
    abortSignal: new AbortController().signal,
  };
}

describe("message_callback", () => {
  it("takes the recipient from the sibling message of the live update", async () => {
    const { buildCallbackMessage } = await import("./monitor.js");
    const update = structuredClone(LIVE_MESSAGE_CALLBACK) as unknown as MaxUpdate;

    const synthetic = buildCallbackMessage(update.callback!, update.message ?? null);

    expect(synthetic.recipient).toEqual({ chat_type: "dialog", chat_id: 242316535, user_id: 4260364 });
    expect(synthetic.sender?.user_id).toBe(4260364);
    expect(synthetic.body).toEqual({ mid: LIVE_MESSAGE_CALLBACK.callback.callback_id, text: "live-callback-test" });
    expect(synthetic.__maxCallback).toBe(true);
  });

  it("falls back to the pressing user only when the keyboard message is gone", async () => {
    const { buildCallbackMessage } = await import("./monitor.js");
    const update = structuredClone(LIVE_MESSAGE_CALLBACK) as unknown as MaxUpdate;

    const synthetic = buildCallbackMessage(update.callback!, null);

    expect(synthetic.recipient).toEqual({ chat_id: 4260364 });
  });

  it("dispatches a live DM callback into the dialog chat, routed by the sender", async () => {
    const { setMaxRuntime } = await import("./runtime.js");
    const { dispatchUpdate } = await import("./monitor.js");
    const { core, dispatched } = makeCallbackRuntime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setMaxRuntime(core as any);

    await dispatchUpdate(
      structuredClone(LIVE_MESSAGE_CALLBACK) as unknown as MaxUpdate,
      makeCallbackOpts({ dmPolicy: "allowlist", allowFrom: ["4260364"] }),
    );

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      ChatType: "direct",
      From: "max:4260364",
      To: "max:242316535",
      OriginatingTo: "max:242316535",
      RawBody: "live-callback-test",
    });
    expect(core.channel.routing.resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({ peer: { kind: "direct", id: "4260364" } }),
    );
  });

  it("keeps a group callback in the group chat and lets it past the mention gate", async () => {
    const { setMaxRuntime } = await import("./runtime.js");
    const { dispatchUpdate } = await import("./monitor.js");
    const { core, dispatched } = makeCallbackRuntime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setMaxRuntime(core as any);

    const update = structuredClone(LIVE_MESSAGE_CALLBACK) as unknown as MaxUpdate;
    update.message!.recipient = { chat_type: "chat", chat_id: -71158913982654 };

    await dispatchUpdate(update, makeCallbackOpts({ groupPolicy: "allowlist", groups: { "-71158913982654": {} } }));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      ChatType: "group",
      To: "max:-71158913982654",
      WasMentioned: true,
    });
    expect(core.channel.routing.resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({ peer: { kind: "group", id: "-71158913982654" } }),
    );
  });
});

describe("edit streaming (streamMode: partial)", () => {
  it("puts the keyboard of the final answer onto the edited draft", async () => {
    const { setMaxRuntime } = await import("./runtime.js");
    const { processIncomingMessage } = await import("./monitor.js");
    const { core } = makeCallbackRuntime();
    const requests: { method: string; url: string; body: Record<string, unknown> }[] = [];
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({ method: String(init?.method), url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ success: true, message: { body: { mid: "mid.draft" } } }), { status: 200 });
    }) as typeof fetch;
    const draftText = "Черновик ответа, достаточно длинный для отправки";
    core.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (params: {
      dispatcherOptions: { deliver: (payload: Record<string, unknown>) => Promise<void> };
      replyOptions: { onPartialReply?: (payload: { text?: string }) => void };
    }) => {
      params.replyOptions.onPartialReply?.({ text: draftText });
      await vi.waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true));
      await params.dispatcherOptions.deliver({
        text: draftText,
        channelData: { max: { buttons: [[{ text: "Ещё", payload: "more" }]] } },
      });
    }) as never;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setMaxRuntime(core as any);
    try {
      await processIncomingMessage(
        {
          sender: { user_id: 7, first_name: "Ann", is_bot: false },
          recipient: { chat_id: 70, chat_type: "dialog" },
          timestamp: 1,
          body: { mid: "mid.in", text: "привет" },
        } as unknown as MaxMessage,
        null,
        makeCallbackOpts({ dmPolicy: "open", streamMode: "partial" }),
      );
    } finally {
      global.fetch = originalFetch;
    }

    const sends = requests.filter((r) => r.method === "POST" && r.url.includes("/messages"));
    const edits = requests.filter((r) => r.method === "PUT");
    // Same text, but the buttons still arrive via the edit, not a second message.
    expect(sends).toHaveLength(1);
    expect(edits).toHaveLength(1);
    expect(edits[0].url).toContain("message_id=mid.draft");
    expect(edits[0].body.attachments).toEqual([
      { type: "inline_keyboard", payload: { buttons: [[{ type: "callback", text: "Ещё", payload: "more" }]] } },
    ]);
  });
});

describe("typing indicator", () => {
  async function run(message: Record<string, unknown>, accountConfig: Record<string, unknown>, botUsername?: string) {
    const { setMaxRuntime } = await import("./runtime.js");
    const { dispatchUpdate } = await import("./monitor.js");
    const { core, dispatched } = makeCallbackRuntime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setMaxRuntime(core as any);
    const opts = { ...makeCallbackOpts(accountConfig), botUserId: 900, botUsername };
    await dispatchUpdate({ update_type: "message_created", timestamp: 1, message } as unknown as MaxUpdate, opts);
    const actions = (opts.api.sendAction as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    return { actions, dispatched };
  }

  it("sends typing_on once per message that reaches the agent", async () => {
    const { actions, dispatched } = await run({
      sender: { user_id: 7, first_name: "Ann", is_bot: false },
      recipient: { chat_id: 70, chat_type: "dialog" },
      timestamp: 1,
      body: { mid: "mid.t1", text: "привет" },
    }, { dmPolicy: "open" });
    expect(dispatched).toHaveLength(1);
    expect(actions.filter((a) => a === "typing_on")).toHaveLength(1);
    expect(actions.filter((a) => a === "mark_seen")).toHaveLength(1);
  });

  it("does not show typing for a group message the bot ignores", async () => {
    const { actions, dispatched } = await run({
      sender: { user_id: 7, first_name: "Ann", is_bot: false },
      recipient: { chat_id: -100, chat_type: "chat" },
      timestamp: 1,
      body: { mid: "mid.t2", text: "просто болтаем" },
    }, { groupPolicy: "open" }, "banzai_bot");
    expect(dispatched).toHaveLength(0);
    expect(actions).not.toContain("typing_on");
  });
});

describe("group mentions via body.markup", () => {
  it("recognises user_mention by user_id or user_link", async () => {
    const { isBotMentionedInMarkup } = await import("./monitor.js");
    expect(isBotMentionedInMarkup([{ type: "user_mention", from: 0, length: 6, user_id: 900 }], 900, "banzai_bot")).toBe(true);
    expect(isBotMentionedInMarkup([{ type: "user_mention", from: 0, length: 11, user_link: "@Banzai_Bot" }], 900, "banzai_bot")).toBe(true);
    expect(isBotMentionedInMarkup([{ type: "user_mention", from: 0, length: 5, user_link: "@other" }], 900, "banzai_bot")).toBe(false);
    expect(isBotMentionedInMarkup([{ type: "user_mention", from: 0, length: 5, user_id: 901 }], 900, "banzai_bot")).toBe(false);
    expect(isBotMentionedInMarkup([{ type: "strong", from: 0, length: 5 }], 900, "banzai_bot")).toBe(false);
    expect(isBotMentionedInMarkup(null, 900, "banzai_bot")).toBe(false);
  });

  async function runGroup(body: Record<string, unknown>, botUsername?: string) {
    const { setMaxRuntime } = await import("./runtime.js");
    const { dispatchUpdate } = await import("./monitor.js");
    const { core, dispatched } = makeCallbackRuntime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setMaxRuntime(core as any);
    const opts = { ...makeCallbackOpts({ groupPolicy: "open" }), botUserId: 900, botUsername };
    await dispatchUpdate({
      update_type: "message_created",
      timestamp: 1,
      message: {
        sender: { user_id: 7, first_name: "Ann", is_bot: false },
        recipient: { chat_id: -100, chat_type: "chat" },
        timestamp: 1,
        body,
      },
    } as unknown as MaxUpdate, opts);
    return dispatched;
  }

  it("passes the mention gate on a markup mention whose text differs from @username", async () => {
    // Display-name mention: the text has no @banzai_bot, only the markup knows.
    const dispatched = await runGroup({
      mid: "mid.m1",
      text: "Банзай, что нового?",
      markup: [{ type: "user_mention", from: 0, length: 6, user_id: 900 }],
    }, "banzai_bot");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.WasMentioned).toBe(true);
  });

  it("keeps the @username regex as a fallback without markup", async () => {
    expect(await runGroup({ mid: "mid.m2", text: "@banzai_bot привет" }, "banzai_bot")).toHaveLength(1);
    expect(await runGroup({ mid: "mid.m3", text: "привет всем" }, "banzai_bot")).toHaveLength(0);
  });

  it("works with the bot user id alone (no username known)", async () => {
    const dispatched = await runGroup({
      mid: "mid.m4",
      text: "Бот, ответь",
      markup: [{ type: "user_mention", from: 0, length: 3, user_id: 900 }],
    });
    expect(dispatched).toHaveLength(1);
  });
});
