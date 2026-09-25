/**
 * Tests for MessagePresentation rendering, delivery pin and the presentation
 * callback round trip (render → press → dispatchUpdate).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import type { MaxUpdate } from "./api.js";
import {
  MAX_PRESENTATION_CAPABILITIES,
  decodeMaxPresentationCallback,
  materializeMaxPresentation,
  readMaxDeliveryPin,
  renderMaxPresentation,
  renderMaxPresentationParts,
} from "./presentation.js";
import type { MaxSendButton } from "./send.js";

const approvalMock = vi.hoisted(() => ({ resolve: vi.fn() }));
const questionMock = vi.hoisted(() => ({ resolveOption: vi.fn() }));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: approvalMock.resolve,
}));
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", () => ({
  questionGatewayRuntime: { resolveOption: questionMock.resolveOption },
}));

const APPROVAL_ID = "3f1c2b7e-0d7a-4a3e-9d1f-8f2c6a1b5e44";
const QUESTION_ID = `ask_${"a1".repeat(16)}`;

const CARD: MessagePresentation = {
  title: "Deploy approval",
  tone: "warning",
  blocks: [
    { type: "text", text: "Canary is ready to promote." },
    { type: "context", text: "Build 1234, staging passed." },
    { type: "divider" },
    {
      type: "buttons",
      buttons: [
        { label: "Approve", action: { type: "callback", value: "deploy:approve" } },
        { label: "Status", action: { type: "command", command: "/status" } },
        { label: "Notes", action: { type: "url", url: "https://example.com/release" } },
        { label: "Allow once", action: { type: "approval", approvalId: APPROVAL_ID, approvalKind: "exec", decision: "allow-once" } },
        { label: "Yes", action: { type: "question", questionId: QUESTION_ID, optionValue: "yes" } },
      ],
    },
  ],
};

function flat(buttons: MaxSendButton[][]): MaxSendButton[] {
  return buttons.flat();
}

describe("renderMaxPresentationParts", () => {
  it("renders title/tone, text, context and divider into MAX markdown", () => {
    const { text } = renderMaxPresentationParts({ presentation: CARD });
    expect(text).toBe([
      "⚠️ **Deploy approval**",
      "Canary is ready to promote.",
      "_Build 1234, staging passed._",
      "———",
    ].join("\n\n"));
  });

  it("does not repeat a title the message text already starts with", () => {
    const { text } = renderMaxPresentationParts({
      presentation: { title: "Deploy approval", blocks: [{ type: "text", text: "Body" }] },
      text: "Deploy approval — please review",
    });
    expect(text.startsWith("Deploy approval — please review")).toBe(true);
    expect(text).not.toContain("**Deploy approval**");
  });

  it("maps actions to MAX buttons and private callback payloads, 3 per row", () => {
    const { buttons } = renderMaxPresentationParts({ presentation: CARD });
    expect(buttons.map((row) => row.length)).toEqual([3, 2]);
    expect(flat(buttons)).toEqual([
      { text: "Approve", type: "callback", payload: "mxcb1:deploy:approve" },
      { text: "Status", type: "callback", payload: "/status" },
      { text: "Notes", type: "link", url: "https://example.com/release" },
      { text: "Allow once", type: "callback", payload: `mxa1:e:o:${APPROVAL_ID}` },
      { text: "Yes", type: "callback", payload: `mxq1:${QUESTION_ID}:yes` },
    ]);
  });

  it("keeps legacy value buttons opaque and maps URL web apps to links", () => {
    const { buttons, text } = renderMaxPresentationParts({
      presentation: {
        blocks: [{
          type: "buttons",
          buttons: [
            { label: "Legacy", value: "/not-a-command" },
            { label: "App", action: { type: "web-app", url: "https://app.example/x" } },
            { label: "Widget", action: { type: "web-app", widgetId: "w1" } },
            { label: "Other…", action: { type: "question", questionId: QUESTION_ID, intent: "custom-input" } },
          ],
        }],
      },
    });
    expect(flat(buttons)).toEqual([
      { text: "Legacy", type: "callback", payload: "mxcb1:/not-a-command" },
      { text: "App", type: "link", url: "https://app.example/x" },
    ]);
    // Dropped controls stay visible as labels.
    expect(text).toContain("Widget");
    expect(text).toContain("Other…");
  });

  it("renders select options as callback rows of two", () => {
    const { buttons } = renderMaxPresentationParts({
      presentation: {
        blocks: [{
          type: "select",
          placeholder: "Environment",
          options: [
            { label: "Canary", value: "env:canary" },
            { label: "Production", action: { type: "callback", value: "env:prod" } },
            { label: "Restart", action: { type: "command", command: "restart" } },
          ],
        }],
      },
    });
    expect(buttons).toEqual([
      [
        { text: "Canary", type: "callback", payload: "mxcb1:env:canary" },
        { text: "Production", type: "callback", payload: "mxcb1:env:prod" },
      ],
      [{ text: "Restart", type: "callback", payload: "/restart" }],
    ]);
  });

  it("renders tables and charts as monospace blocks", () => {
    const { text } = renderMaxPresentationParts({
      presentation: {
        blocks: [
          {
            type: "table",
            caption: "Open pipeline",
            headers: ["Account", "Stage", "ARR"],
            rows: [["Acme", "Won", 125000], ["Globex", "Review", 82000]],
          },
          {
            type: "chart",
            chartType: "bar",
            title: "Revenue",
            categories: ["Q1", "Q2"],
            series: [{ name: "Product", values: [120, 145] }],
            xLabel: "Quarter",
            yLabel: "USD",
          },
          { type: "chart", chartType: "pie", title: "Share", segments: [{ label: "A", value: 1 }, { label: "B", value: 3 }] },
        ],
      },
    });
    expect(text).toContain([
      "**Open pipeline**",
      "```",
      "Account | Stage  | ARR",
      "--------+--------+-------",
      "Acme    | Won    | 125000",
      "Globex  | Review | 82000",
      "```",
    ].join("\n"));
    expect(text).toContain("**Revenue** (bar, USD)\n```\nQuarter | Product\n");
    expect(text).toContain("Q2      | 145");
    expect(text).toContain("B | 3 | 75.0%");
  });

  it("enforces MAX limits: 128-char labels, 1024-byte payloads, 30 rows, 210 buttons", () => {
    const longLabel = "x".repeat(200);
    const clipped = renderMaxPresentationParts({
      presentation: { blocks: [{ type: "buttons", buttons: [{ label: longLabel, value: "v" }] }] },
    });
    expect(Array.from(flat(clipped.buttons)[0].text)).toHaveLength(128);
    expect(flat(clipped.buttons)[0].text.endsWith("…")).toBe(true);

    const oversized = renderMaxPresentationParts({
      presentation: { blocks: [{ type: "buttons", buttons: [{ label: "Big", value: "y".repeat(1100) }] }] },
    });
    expect(oversized.buttons).toEqual([]);
    expect(oversized.text).toContain("Big");

    const many = renderMaxPresentationParts({
      presentation: {
        blocks: [{
          type: "buttons",
          buttons: Array.from({ length: 100 }, (_, index) => ({ label: `b${index}`, value: `v${index}` })),
        }],
      },
    });
    expect(many.buttons).toHaveLength(30);
    expect(flat(many.buttons)).toHaveLength(90);
    expect(many.buttons.every((row) => row.length <= 3)).toBe(true);
    expect(many.text).toContain("b99");
  });
});

describe("core adaptation with MAX capabilities", () => {
  it("advertises the MAX envelope", () => {
    expect(MAX_PRESENTATION_CAPABILITIES).toMatchObject({
      supported: true,
      buttons: true,
      selects: true,
      tables: true,
      charts: true,
      limits: { actions: { maxRows: 30, maxLabelLength: 128 }, text: { maxLength: 4000 } },
    });
  });

  it("materializes a presentation payload into text + channelData.max.buttons", async () => {
    const out = await materializeMaxPresentation({ text: "Heads up", presentation: CARD });
    expect(out.presentation).toBeUndefined();
    expect(out.text).toContain("Heads up");
    expect(out.text).toContain("**Deploy approval**");
    const buttons = (out.channelData as { max: { buttons: MaxSendButton[][] } }).max.buttons;
    expect(flat(buttons).map((button) => button.text)).toEqual(["Approve", "Status", "Notes", "Allow once", "Yes"]);
  });

  it("keeps existing channelData.max buttons and options", () => {
    const out = renderMaxPresentation(
      {
        text: "t",
        channelData: { max: { notify: false, buttons: [[{ text: "Old", payload: "old" }]] } },
      },
      { blocks: [{ type: "buttons", buttons: [{ label: "New", value: "new" }] }] },
    );
    expect(out.channelData).toEqual({
      max: {
        notify: false,
        buttons: [[{ text: "Old", payload: "old" }], [{ text: "New", type: "callback", payload: "mxcb1:new" }]],
      },
    });
  });

  it("passes payloads without presentation through untouched", async () => {
    const payload = { text: "plain", channelData: { max: { buttons: [[{ text: "a" }]] } } };
    expect(await materializeMaxPresentation(payload)).toBe(payload);
  });
});

describe("decodeMaxPresentationCallback", () => {
  it("round-trips every private envelope and ignores legacy payloads", () => {
    const payloads = flat(renderMaxPresentationParts({ presentation: CARD }).buttons)
      .map((button) => button.payload);
    expect(payloads.map(decodeMaxPresentationCallback)).toEqual([
      { kind: "callback", value: "deploy:approve" },
      null, // command text re-enters as a user message
      null, // link
      { kind: "approval", approvalId: APPROVAL_ID, approvalKind: "exec", decision: "allow-once" },
      { kind: "question", questionId: QUESTION_ID, optionValue: "yes" },
    ]);
    expect(decodeMaxPresentationCallback("live-callback-test")).toBeNull();
    expect(decodeMaxPresentationCallback("mxa1:x:o:id")).toBeNull();
    expect(decodeMaxPresentationCallback("mxq1:nocolon")).toBeNull();
  });
});

describe("readMaxDeliveryPin", () => {
  it("normalizes delivery.pin and the pin flag", () => {
    expect(readMaxDeliveryPin({ pin: true })).toEqual({ enabled: true });
    expect(readMaxDeliveryPin({ pin: { enabled: true, notify: true, required: true } }))
      .toEqual({ enabled: true, notify: true, required: true });
    expect(readMaxDeliveryPin({ pin: { enabled: false } })).toBeUndefined();
    expect(readMaxDeliveryPin(undefined, true)).toEqual({ enabled: true });
    expect(readMaxDeliveryPin(undefined)).toBeUndefined();
  });
});

describe("outbound adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("declares presentation and pin delivery and renders through renderPresentation", async () => {
    const { maxPlugin } = await import("./channel.js");
    const outbound = maxPlugin.outbound!;
    expect(outbound.presentationCapabilities).toBe(MAX_PRESENTATION_CAPABILITIES);
    expect(outbound.deliveryCapabilities).toEqual({ pin: true });
    const rendered = await outbound.renderPresentation!({
      payload: { text: "hi" },
      presentation: CARD,
      ctx: {} as never,
    });
    expect((rendered?.channelData as { max: { buttons: unknown[] } }).max.buttons).toHaveLength(2);
  });

  it("pins a chat target with PUT /chats/{chatId}/pin and checks the handoff first", async () => {
    const { maxPlugin } = await import("./channel.js");
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    const assertDirectAdapterHandoff = vi.fn();

    await maxPlugin.outbound!.pinDeliveredMessage!({
      cfg: { channels: { max: { botToken: "tok" } } } as never,
      target: { channel: "max", to: "-7001" },
      messageId: "mid.pinme",
      pin: { enabled: true, notify: true },
      assertDirectAdapterHandoff,
    });

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain("/chats/-7001/pin");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ message_id: "mid.pinme", notify: true });
    expect(assertDirectAdapterHandoff).toHaveBeenCalled();
  });

  it("resolves the dialog chat id of a user target from the sent message", async () => {
    const { maxPlugin } = await import("./channel.js");
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ body: { mid: "mid.dm" }, recipient: { chat_id: 242316535, chat_type: "dialog", user_id: 4260364 } }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });

    await maxPlugin.outbound!.pinDeliveredMessage!({
      cfg: { channels: { max: { botToken: "tok" } } } as never,
      target: { channel: "max", to: "user:4260364" },
      messageId: "mid.dm",
      pin: { enabled: true },
    });

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(String(calls[0][0])).toContain("/messages/mid.dm");
    expect(String(calls[1][0])).toContain("/chats/242316535/pin");
    expect(JSON.parse(calls[1][1].body)).toEqual({ message_id: "mid.dm", notify: false });
  });
});

// ── Round trip: render → press (message_callback in the live fixture shape) → dispatchUpdate ──

function makeRuntime() {
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

function pressUpdate(payload: string, userId = 4260364): MaxUpdate {
  return {
    update_type: "message_callback",
    timestamp: 1790372541327,
    callback: {
      timestamp: 1790372541327,
      callback_id: "cb.presentation.1",
      user: { user_id: userId, first_name: "User", is_bot: false, name: "User" },
      payload,
    },
    message: {
      recipient: { chat_type: "dialog", chat_id: 242316535, user_id: userId },
      timestamp: 1790372383780,
      body: { mid: "mid.card", text: "Deploy approval" },
      sender: { user_id: 238057211, first_name: "Bot", is_bot: true },
    },
    user_locale: "ru",
  } as unknown as MaxUpdate;
}

function makeOpts(accountConfig: Record<string, unknown>) {
  return {
    api: {
      sendAction: vi.fn(async () => ({ success: true })),
      answerCallback: vi.fn(async () => ({ success: true })),
    },
    account: { accountId: "default", enabled: true, token: "t", tokenSource: "config" as const, config: accountConfig },
    config: { channels: {} },
    abortSignal: new AbortController().signal,
  };
}

function buttonPayload(label: string): string {
  const button = flat(renderMaxPresentationParts({ presentation: CARD }).buttons).find((b) => b.text === label);
  return button!.payload!;
}

describe("agent reply funnel", () => {
  it("renders a presentation reply as a keyboard message and pins it", async () => {
    const { setMaxRuntime } = await import("./runtime.js");
    const { dispatchUpdate } = await import("./monitor.js");
    const { core } = makeRuntime();
    Object.assign(core.channel, {
      text: {
        resolveChunkMode: vi.fn(() => "length"),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
      },
    });
    core.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (params: unknown) => {
      const { dispatcherOptions } = params as {
        dispatcherOptions: { deliver: (payload: unknown, info: unknown) => Promise<void> };
      };
      await dispatcherOptions.deliver({ text: "Готово", presentation: CARD, delivery: { pin: true } }, { kind: "final" });
    }) as never;
    setMaxRuntime(core as never);
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: { body: { mid: "mid.reply" }, recipient: { chat_id: 242316535 } } }),
      })
      .mockResolvedValue({ ok: true, json: async () => ({ success: true }) });

    await dispatchUpdate(
      {
        update_type: "message_created",
        timestamp: 1,
        message: {
          sender: { user_id: 4260364, first_name: "User" },
          recipient: { chat_type: "dialog", chat_id: 242316535 },
          timestamp: 1,
          body: { mid: "mid.in", text: "deploy?" },
        },
      } as unknown as MaxUpdate,
      { ...makeOpts({ dmPolicy: "allowlist", allowFrom: ["4260364"], markSeen: false }), token: "t" } as never,
    );

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const send = calls.find(([url, init]) => String(url).includes("/messages") && init.method === "POST");
    expect(send).toBeDefined();
    const body = JSON.parse(send![1].body);
    expect(body.text).toContain("Готово");
    expect(body.text).toContain("**Deploy approval**");
    expect(body.attachments[0].payload.buttons.flat().map((b: { text: string }) => b.text))
      .toEqual(["Approve", "Status", "Notes", "Allow once", "Yes"]);
    const pin = calls.find(([url]) => String(url).includes("/chats/242316535/pin"));
    expect(pin).toBeDefined();
    expect(JSON.parse(pin![1].body)).toEqual({ message_id: "mid.reply", notify: false });
  });
});
