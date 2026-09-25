/**
 * MessagePresentation → MAX message (text in MAX markdown + inline_keyboard).
 *
 * Contract: docs/plugins/message-presentation.md. Core adapts a presentation to
 * `MAX_PRESENTATION_CAPABILITIES` and calls `renderMaxPresentation`; the result
 * is an ordinary payload with `channelData.max.buttons`, sent by sendPayload.
 * Channel-local funnels (agent replies, the message tool) go through the same
 * `renderPresentationForDelivery` so they behave identically.
 *
 * Presentation actions become transport-private callback payloads (≤1024
 * bytes) that `decodeMaxPresentationCallback` maps back on `message_callback`:
 * - command  → the command text itself ("/status"): it re-enters as a user
 *              message and takes core's native command path;
 * - callback → "mxcb1:<value>": opaque, delivered to the agent as
 *              "callback_data: <value>" and never parsed as a slash command;
 * - approval → "mxa1:<e|p|s>:<o|a|d>:<approvalId>": resolved through the
 *              canonical approval service (approval-gateway-runtime);
 * - question → "mxq1:<questionId>:<optionValue>": resolved through
 *              question-gateway-runtime;
 * - url / URL-backed web-app → a MAX `link` button.
 */

import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { ReplyPayload } from "openclaw/plugin-sdk/core";
import {
  type MessagePresentation,
  type MessagePresentationBlock,
  type MessagePresentationButton,
  type MessagePresentationOption,
  renderMessagePresentationFallbackText,
  renderPresentationForDelivery,
  type ReplyPayloadDelivery,
  resolveMessagePresentationButtonAction,
  resolveMessagePresentationOptionAction,
} from "openclaw/plugin-sdk/interactive-runtime";

import type { MaxSendButton } from "./send.js";

type ChannelPresentationCapabilities = NonNullable<ChannelOutboundAdapter["presentationCapabilities"]>;

/** MAX Bot API limits (schema.yaml: Button.text, CallbackButton.payload, InlineKeyboard). */
export const MAX_BUTTON_TEXT_LIMIT = 128;
export const MAX_CALLBACK_PAYLOAD_BYTES = 1024;
export const MAX_KEYBOARD_ROWS = 30;
export const MAX_KEYBOARD_BUTTONS = 210;
export const MAX_LINK_URL_LENGTH = 2048;
export const MAX_TEXT_LIMIT = 4000;
/** Buttons per row we render: within MAX's 7 (3 for link/open_app/request_*). */
const BUTTONS_PER_ROW = 3;
const SELECT_OPTIONS_PER_ROW = 2;

export const MAX_PRESENTATION_CAPABILITIES: ChannelPresentationCapabilities = {
  supported: true,
  buttons: true,
  selects: true,
  context: true,
  divider: true,
  // Rendered as monospace text blocks (MAX has no native charts/tables).
  charts: true,
  tables: true,
  limits: {
    actions: {
      maxActions: MAX_KEYBOARD_BUTTONS,
      maxActionsPerRow: BUTTONS_PER_ROW,
      maxRows: MAX_KEYBOARD_ROWS,
      maxLabelLength: MAX_BUTTON_TEXT_LIMIT,
      // Leave room for the private envelope prefix inside the 1024-byte payload.
      maxValueBytes: 960,
      supportsStyles: false,
      supportsDisabled: false,
    },
    selects: {
      maxOptions: 20,
      maxLabelLength: MAX_BUTTON_TEXT_LIMIT,
      maxValueBytes: 960,
    },
    text: {
      maxLength: MAX_TEXT_LIMIT,
      encoding: "characters",
      markdownDialect: "markdown",
    },
  },
};

// ── Callback envelopes ──

const CALLBACK_PREFIX = "mxcb1:";
const APPROVAL_PREFIX = "mxa1:";
const QUESTION_PREFIX = "mxq1:";

type ApprovalKind = "exec" | "plugin" | "system-agent";
type ApprovalDecision = "allow-once" | "allow-always" | "deny";

const APPROVAL_KIND_CODES: Record<ApprovalKind, string> = { exec: "e", plugin: "p", "system-agent": "s" };
const APPROVAL_DECISION_CODES: Record<ApprovalDecision, string> = { "allow-once": "o", "allow-always": "a", deny: "d" };

export type MaxPresentationCallback =
  | { kind: "callback"; value: string }
  | { kind: "approval"; approvalId: string; approvalKind: ApprovalKind; decision: ApprovalDecision }
  | { kind: "question"; questionId: string; optionValue: string };

function fitsPayload(payload: string): boolean {
  return payload.length > 0 && Buffer.byteLength(payload, "utf8") <= MAX_CALLBACK_PAYLOAD_BYTES;
}

/** Decode a payload produced by this renderer; null for anything else (legacy buttons). */
export function decodeMaxPresentationCallback(payload: string | undefined | null): MaxPresentationCallback | null {
  if (!payload) return null;
  if (payload.startsWith(CALLBACK_PREFIX)) {
    const value = payload.slice(CALLBACK_PREFIX.length);
    return value ? { kind: "callback", value } : null;
  }
  if (payload.startsWith(APPROVAL_PREFIX)) {
    const match = /^mxa1:([eps]):([oad]):(.+)$/su.exec(payload);
    if (!match) return null;
    const approvalKind = (Object.keys(APPROVAL_KIND_CODES) as ApprovalKind[])
      .find((kind) => APPROVAL_KIND_CODES[kind] === match[1]);
    const decision = (Object.keys(APPROVAL_DECISION_CODES) as ApprovalDecision[])
      .find((code) => APPROVAL_DECISION_CODES[code] === match[2]);
    return approvalKind && decision ? { kind: "approval", approvalKind, decision, approvalId: match[3] } : null;
  }
  if (payload.startsWith(QUESTION_PREFIX)) {
    const rest = payload.slice(QUESTION_PREFIX.length);
    const separator = rest.indexOf(":");
    if (separator <= 0 || separator === rest.length - 1) return null;
    return { kind: "question", questionId: rest.slice(0, separator), optionValue: rest.slice(separator + 1) };
  }
  return null;
}

// ── Controls ──

type ControlResult = { button: MaxSendButton } | { dropped: string };

function clipLabel(label: string): string {
  const chars = Array.from(label.trim());
  return chars.length <= MAX_BUTTON_TEXT_LIMIT ? chars.join("") : `${chars.slice(0, MAX_BUTTON_TEXT_LIMIT - 1).join("")}…`;
}

function callbackButton(label: string, payload: string): ControlResult {
  return fitsPayload(payload) ? { button: { text: clipLabel(label), type: "callback", payload } } : { dropped: label };
}

function linkButton(label: string, url: string): ControlResult {
  const trimmed = url.trim();
  if (!/^https?:\/\//iu.test(trimmed) || trimmed.length > MAX_LINK_URL_LENGTH) return { dropped: label };
  return { button: { text: clipLabel(label), type: "link", url: trimmed } };
}

function commandPayload(command: string): string {
  const trimmed = command.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function toControl(button: MessagePresentationButton): ControlResult {
  const label = button.label;
  const action = resolveMessagePresentationButtonAction(button);
  if (!action || button.disabled) return { dropped: label };
  switch (action.type) {
    case "url":
      return linkButton(label, action.url);
    case "web-app":
      // MAX open_app addresses a bot's mini app by name, not by URL.
      return action.url ? linkButton(label, action.url) : { dropped: label };
    case "command":
      return action.command.trim() ? callbackButton(label, commandPayload(action.command)) : { dropped: label };
    case "callback":
      return callbackButton(label, `${CALLBACK_PREFIX}${action.value}`);
    case "approval": {
      const kind = APPROVAL_KIND_CODES[action.approvalKind as ApprovalKind];
      const decision = APPROVAL_DECISION_CODES[action.decision as ApprovalDecision];
      if (!kind || !decision || !action.approvalId) return { dropped: label };
      return callbackButton(label, `${APPROVAL_PREFIX}${kind}:${decision}:${action.approvalId}`);
    }
    case "question":
      // custom-input needs a free-text composer target MAX cannot address; the
      // producer states the text route in the message, so the control is omitted.
      if ("intent" in action || action.questionId.includes(":")) return { dropped: label };
      return callbackButton(label, `${QUESTION_PREFIX}${action.questionId}:${action.optionValue}`);
    default:
      return { dropped: label };
  }
}

function toOptionControl(option: MessagePresentationOption): ControlResult {
  const action = resolveMessagePresentationOptionAction(option);
  if (!action) return { dropped: option.label };
  return action.type === "command"
    ? callbackButton(option.label, commandPayload(action.command))
    : callbackButton(option.label, `${CALLBACK_PREFIX}${action.value}`);
}

// ── Text ──

const TONE_PREFIX: Record<string, string> = {
  info: "ℹ️",
  success: "✅",
  warning: "⚠️",
  danger: "⛔",
};

function collapse(value: string | number): string {
  return String(value).replace(/\s+/gu, " ").replace(/`/gu, "'").trim();
}

function monospaceTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(Array.from(header).length, ...rows.map((row) => Array.from(row[column] ?? "").length)),
  );
  const pad = (cells: string[]) =>
    cells.map((cell, column) => cell + " ".repeat(Math.max(0, widths[column] - Array.from(cell).length))).join(" | ").trimEnd();
  const lines = [pad(headers), widths.map((width) => "-".repeat(Math.max(1, width))).join("-+-"), ...rows.map(pad)];
  return ["```", ...lines, "```"].join("\n");
}

function renderDataBlock(block: Extract<MessagePresentationBlock, { type: "table" | "chart" }>): string {
  if (block.type === "table") {
    return [
      `**${collapse(block.caption)}**`,
      monospaceTable(block.headers.map(collapse), block.rows.map((row) => row.map(collapse))),
    ].join("\n");
  }
  if (block.chartType === "pie") {
    const total = block.segments.reduce((sum, segment) => sum + segment.value, 0);
    const rows = block.segments.map((segment) => [
      collapse(segment.label),
      collapse(segment.value),
      total > 0 ? `${((segment.value / total) * 100).toFixed(1)}%` : "",
    ]);
    return [`**${collapse(block.title)}** (pie)`, monospaceTable(["", "", "%"], rows)].join("\n");
  }
  const headers = [collapse(block.xLabel ?? ""), ...block.series.map((series) => collapse(series.name))];
  const rows = block.categories.map((category, index) => [
    collapse(category),
    ...block.series.map((series) => collapse(series.values[index] ?? "")),
  ]);
  const axis = block.yLabel ? `, ${collapse(block.yLabel)}` : "";
  return [`**${collapse(block.title)}** (${block.chartType}${axis})`, monospaceTable(headers, rows)].join("\n");
}

function renderContext(text: string): string {
  const trimmed = text.trim();
  return /[_*\n]/u.test(trimmed) ? trimmed : `_${trimmed}_`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size));
  return rows;
}

export type MaxRenderedPresentation = {
  text: string;
  buttons: MaxSendButton[][];
};

/** Pure mapping of an (already adapted) presentation to MAX text + keyboard rows. */
export function renderMaxPresentationParts(params: {
  presentation: MessagePresentation;
  text?: string | null;
}): MaxRenderedPresentation {
  const { presentation } = params;
  const baseText = params.text?.trim() ?? "";
  const parts: string[] = [];

  const title = presentation.title?.trim();
  if (title && !baseText.startsWith(title)) {
    const tone = presentation.tone ? TONE_PREFIX[presentation.tone] : undefined;
    parts.push(tone ? `${tone} **${title}**` : `**${title}**`);
  }
  if (baseText) parts.push(baseText);

  const rows: MaxSendButton[][] = [];
  const dropped: string[] = [];
  let buttonCount = 0;
  const pushRows = (candidates: MaxSendButton[][]) => {
    for (const row of candidates) {
      const room = Math.min(row.length, MAX_KEYBOARD_BUTTONS - buttonCount);
      if (rows.length >= MAX_KEYBOARD_ROWS || room <= 0) {
        dropped.push(...row.map((button) => button.text));
        continue;
      }
      rows.push(row.slice(0, room));
      dropped.push(...row.slice(room).map((button) => button.text));
      buttonCount += room;
    }
  };

  for (const block of presentation.blocks) {
    switch (block.type) {
      case "text":
        if (block.text.trim()) parts.push(block.text.trim());
        break;
      case "context":
        if (block.text.trim()) parts.push(renderContext(block.text));
        break;
      case "divider":
        parts.push("———");
        break;
      case "table":
      case "chart":
        parts.push(renderDataBlock(block));
        break;
      case "buttons": {
        const buttons: MaxSendButton[] = [];
        for (const control of block.buttons.map(toControl)) {
          if ("button" in control) buttons.push(control.button);
          else dropped.push(control.dropped);
        }
        pushRows(chunk(buttons, BUTTONS_PER_ROW));
        break;
      }
      case "select": {
        const options: MaxSendButton[] = [];
        for (const control of block.options.map(toOptionControl)) {
          if ("button" in control) options.push(control.button);
          else dropped.push(control.dropped);
        }
        pushRows(chunk(options, SELECT_OPTIONS_PER_ROW));
        break;
      }
    }
  }

  if (dropped.length > 0) {
    // Label-only fallback, as core renders controls a channel cannot carry.
    const fallback = renderMessagePresentationFallbackText({
      presentation: { blocks: [{ type: "buttons", buttons: dropped.map((label) => ({ label, value: "unavailable" })) }] },
    });
    if (fallback) parts.push(fallback);
  }

  return { text: parts.join("\n\n"), buttons: rows };
}

function readChannelDataMax(channelData: unknown): Record<string, unknown> {
  if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) return {};
  const max = (channelData as Record<string, unknown>).max;
  return max && typeof max === "object" && !Array.isArray(max) ? (max as Record<string, unknown>) : {};
}

/** `renderPresentation` for the outbound adapter: presentation → channelData.max.buttons. */
export function renderMaxPresentation(payload: ReplyPayload, presentation: MessagePresentation): ReplyPayload {
  const rendered = renderMaxPresentationParts({ presentation, text: payload.text });
  const existingMax = readChannelDataMax(payload.channelData);
  const existingButtons = Array.isArray(existingMax.buttons) ? (existingMax.buttons as MaxSendButton[][]) : [];
  const buttons = [...existingButtons, ...rendered.buttons];
  const rest: ReplyPayload = { ...payload };
  delete rest.presentation;
  return {
    ...rest,
    text: rendered.text,
    ...(buttons.length > 0 || payload.channelData
      ? {
        channelData: {
          ...(payload.channelData ?? {}),
          max: { ...existingMax, ...(buttons.length > 0 ? { buttons } : {}) },
        },
      }
      : {}),
  };
}

/** Same adaptation + render + fallback policy core applies on its outbound path. */
export async function materializeMaxPresentation(payload: ReplyPayload): Promise<ReplyPayload> {
  if (!payload.presentation) return payload;
  return renderPresentationForDelivery(
    {
      presentationCapabilities: MAX_PRESENTATION_CAPABILITIES,
      renderPresentation: (adapted) => renderMaxPresentation(adapted, adapted.presentation),
    },
    payload,
  );
}

export type MaxDeliveryPin = { enabled: boolean; notify?: boolean; required?: boolean };

/** Normalize `delivery.pin` (true | {enabled, notify, required}) or the tool's `pin: true`. */
export function readMaxDeliveryPin(delivery: unknown, pinFlag?: unknown): MaxDeliveryPin | undefined {
  const raw = delivery && typeof delivery === "object" && !Array.isArray(delivery)
    ? (delivery as ReplyPayloadDelivery).pin
    : undefined;
  if (raw === true) return { enabled: true };
  if (raw && typeof raw === "object" && raw.enabled) {
    return { enabled: true, notify: raw.notify === true, required: raw.required === true };
  }
  if (pinFlag === true) return { enabled: true };
  return undefined;
}
