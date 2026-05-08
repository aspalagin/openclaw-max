/**
 * MAX Messenger Bot — inline keyboard & callback answers
 *
 * Sends messages with inline buttons and answers callback queries.
 * Zero external dependencies — Node 18+ built-in fetch.
 */

import type { InlineButton, Message } from "./types.js";

// ─── Constants ──────────────────────────────────────────────────

const API_BASE = "https://platform-api.max.ru";

// ─── Types ──────────────────────────────────────────────────────

/** Button definition for sendWithButtons */
export interface ButtonDef {
  /** Button label */
  text: string;
  /** Button type (default: "callback") */
  type?: InlineButton["type"];
  /** Callback payload (for type "callback") */
  payload?: string;
  /** URL (for type "link") */
  url?: string;
  /** Visual intent */
  intent?: "default" | "positive" | "negative";
}

export interface SendWithButtonsResult {
  /** Message ID of the sent message */
  messageId: string;
  /** Full message object from API */
  message: Message;
}

export interface AnswerCallbackOptions {
  /** Updated message body (optional) */
  message?: {
    text?: string;
    attachments?: unknown[];
    format?: "markdown" | "html";
  };
  /** One-time notification text shown to user (optional) */
  notification?: string;
}

// ─── Helpers ────────────────────────────────────────────────────

function log(msg: string): void {
  process.stderr.write(`[max-buttons] ${new Date().toISOString()} ${msg}\n`);
}

function buildInlineButton(def: ButtonDef): InlineButton {
  const btn: InlineButton = {
    type: def.type ?? "callback",
    text: def.text,
  };

  if (btn.type === "callback" || btn.type === "clipboard") {
    btn.payload = def.payload ?? def.text;
  }

  if (btn.type === "link" && def.url) {
    btn.url = def.url;
  }

  if (def.intent) {
    btn.intent = def.intent;
  }

  return btn;
}

// ─── sendWithButtons ────────────────────────────────────────────

/**
 * Send a text message with inline keyboard to a chat.
 *
 * @param token    Bot API token
 * @param chatId   Target chat_id or user_id
 * @param text     Message text (up to 4000 chars)
 * @param buttons  2D array of button definitions (rows × columns)
 * @param options  Additional options
 * @returns        Message ID and full message object
 *
 * @example
 * ```ts
 * const result = await sendWithButtons(token, 12345, "Choose:", [
 *   [
 *     { text: "Yes", payload: "yes", intent: "positive" },
 *     { text: "No", payload: "no", intent: "negative" },
 *   ],
 *   [
 *     { text: "Open docs", type: "link", url: "https://dev.max.ru" },
 *   ],
 * ]);
 * ```
 */
export async function sendWithButtons(
  token: string,
  chatId: number,
  text: string,
  buttons: ButtonDef[][],
  options?: {
    /** Send to user_id instead of chat_id */
    isUser?: boolean;
    /** Text format */
    format?: "markdown" | "html";
    /** Disable notification */
    notify?: boolean;
  },
): Promise<SendWithButtonsResult> {
  const targetParam = options?.isUser ? "user_id" : "chat_id";
  const url = `${API_BASE}/messages?${targetParam}=${chatId}`;

  const inlineButtons: InlineButton[][] = buttons.map((row) =>
    row.map((def) => buildInlineButton(def)),
  );

  const body: Record<string, unknown> = {
    text,
    attachments: [
      {
        type: "inline_keyboard",
        payload: {
          buttons: inlineButtons,
        },
      },
    ],
  };

  if (options?.format) body.format = options.format;
  if (options?.notify === false) body.notify = false;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    const msg = `sendWithButtons failed: HTTP ${response.status} — ${errBody.slice(0, 300)}`;
    log(msg);
    throw new Error(msg);
  }

  const data = (await response.json()) as { message: Message };
  const messageId = data.message?.body?.mid;

  if (!messageId) {
    throw new Error("sendWithButtons: no message_id in response");
  }

  return { messageId, message: data.message };
}

// ─── answerCallback ─────────────────────────────────────────────

/**
 * Answer a callback button press.
 *
 * Call this after receiving a `message_callback` update to:
 * - Update the original message (optional)
 * - Show a one-time notification to the user (optional)
 *
 * @param token       Bot API token
 * @param callbackId  callback_id from the message_callback update
 * @param options     Response options (updated message and/or notification)
 *
 * @example
 * ```ts
 * // Simple acknowledge
 * await answerCallback(token, callbackId);
 *
 * // Update message + notify
 * await answerCallback(token, callbackId, {
 *   notification: "Принято!",
 *   message: { text: "Вы выбрали: Да ✅" },
 * });
 * ```
 */
export async function answerCallback(
  token: string,
  callbackId: string,
  options?: AnswerCallbackOptions,
): Promise<void> {
  const url = `${API_BASE}/answers?callback_id=${encodeURIComponent(callbackId)}`;

  const body: Record<string, unknown> = {};

  if (options?.message) {
    body.message = {
      text: options.message.text,
      attachments: options.message.attachments,
      format: options.message.format,
    };
  }

  if (options?.notification) {
    body.notification = options.notification;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    const msg = `answerCallback failed: HTTP ${response.status} — ${errBody.slice(0, 300)}`;
    log(msg);
    throw new Error(msg);
  }
}
