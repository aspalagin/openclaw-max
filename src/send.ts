/**
 * Outbound message sending for MAX.
 */

import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";

import {
  MaxApi,
  MaxApiError,
  type MaxNewMessageBody,
  type MaxSendResult,
  type MaxInlineKeyboardAttachment,
  type MaxInlineKeyboardButton,
  type MaxStickerAttachment,
  type MaxAttachment,
} from "./api.js";
import { resolveMaxAccount } from "./accounts.js";
import { toMaxMarkdown } from "./format.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

export type MaxSendButton = {
  text: string;
  /** Button type; default: "link" when url is set, otherwise "callback" */
  type?: "callback" | "link" | "message" | "clipboard" | "open_app" | "request_contact" | "request_geo_location";
  payload?: string;
  callback_data?: string;
  url?: string;
  intent?: "default" | "positive" | "negative";
  /** open_app: public name of the mini-app/bot to open */
  webApp?: string;
};

export interface MaxSendOptions {
  token?: string;
  accountId?: string;
  cfg?: OpenClawConfig;
  replyToMessageId?: string;
  format?: "markdown" | "html";
  disableLinkPreview?: boolean;
  notify?: boolean;
  buttons?: MaxSendButton[][];
}

/** Send target: numeric chat id, or an explicit user id (user:<id> targets). */
export type MaxSendTarget = { chat_id: number } | { user_id: number };

/**
 * Resolve a token from options or config.
 */
function resolveToken(opts: MaxSendOptions): string {
  if (opts.token) return opts.token;
  if (opts.cfg) {
    const account = resolveMaxAccount({ cfg: opts.cfg, accountId: opts.accountId });
    if (account.token) return account.token;
  }
  throw new Error("MAX bot token not available");
}

/**
 * Resolve a target string into API send params.
 * Supported forms: "12345", "max:12345" (chat id), "user:12345" / "max:user:12345"
 * (user id), "@username" / public link (resolved via GET /chats/{chatLink}).
 *
 * Note: GET /chats/{chatLink} resolves only PUBLIC channels/chats that have a
 * link. For ordinary group chats address by numeric chat_id (from bot_added),
 * for users by "user:<id>".
 */
export async function resolveMaxTarget(api: MaxApi, to: string): Promise<MaxSendTarget> {
  let normalized = to.trim();
  if (normalized.startsWith("max:")) normalized = normalized.slice(4);

  if (normalized.startsWith("user:")) {
    const userId = Number(normalized.slice(5));
    if (Number.isNaN(userId)) throw new Error(`Invalid MAX target: ${to}`);
    return { user_id: userId };
  }

  const chatId = Number(normalized);
  if (!Number.isNaN(chatId) && normalized !== "") {
    return { chat_id: chatId };
  }

  // @username or public chat link — resolve through the API
  if (normalized.startsWith("@") || normalized.includes("max.ru/")) {
    const link = normalized.replace(/^(https?:\/\/)?(www\.)?max\.ru\//i, "").replace(/^@/, "");
    try {
      const chat = await api.getChat(link);
      if (chat?.chat_id != null) return { chat_id: chat.chat_id };
    } catch (err) {
      throw new Error(
        `Could not resolve MAX target "${to}" via chat link (only public channels/chats are resolvable; ` +
        `use a numeric chat_id for groups or user:<id> for users): ${String(err)}`,
      );
    }
  }

  throw new Error(`Invalid MAX target: ${to}`);
}

export function readMaxChannelButtons(channelData: unknown): MaxSendButton[][] | undefined {
  if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) return undefined;
  const maxData = (channelData as Record<string, unknown>).max;
  if (!maxData || typeof maxData !== "object" || Array.isArray(maxData)) return undefined;
  const rawButtons = (maxData as Record<string, unknown>).buttons;
  if (!Array.isArray(rawButtons)) return undefined;

  const validTypes = new Set([
    "callback", "link", "message", "clipboard", "open_app", "request_contact", "request_geo_location",
  ]);
  const validIntents = new Set(["default", "positive", "negative"]);

  const rows = rawButtons
    .map((row) => {
      const items = Array.isArray(row) ? row : [row];
      return items
        .filter((button): button is Record<string, unknown> => Boolean(button) && typeof button === "object" && !Array.isArray(button))
        .map((button) => ({
          text: String(button.text ?? button.label ?? ""),
          type: validTypes.has(String(button.type)) ? (String(button.type) as MaxSendButton["type"]) : undefined,
          payload: button.payload != null ? String(button.payload) : undefined,
          callback_data: button.callback_data != null ? String(button.callback_data) : undefined,
          url: button.url != null ? String(button.url) : undefined,
          intent: validIntents.has(String(button.intent)) ? (String(button.intent) as MaxSendButton["intent"]) : undefined,
          webApp: button.webApp != null ? String(button.webApp) : button.web_app != null ? String(button.web_app) : undefined,
        }))
        .filter((button) => button.text.trim().length > 0);
    })
    .filter((row) => row.length > 0);

  return rows.length > 0 ? rows : undefined;
}

/** Extra per-message options passed via channelData.max (notify, link preview). */
export function readMaxChannelSendOptions(channelData: unknown): { notify?: boolean; disableLinkPreview?: boolean } {
  if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) return {};
  const maxData = (channelData as Record<string, unknown>).max;
  if (!maxData || typeof maxData !== "object" || Array.isArray(maxData)) return {};
  const data = maxData as Record<string, unknown>;
  const result: { notify?: boolean; disableLinkPreview?: boolean } = {};
  if (typeof data.notify === "boolean") result.notify = data.notify;
  if (data.silent === true) result.notify = false;
  if (typeof data.disableLinkPreview === "boolean") result.disableLinkPreview = data.disableLinkPreview;
  return result;
}

function buildMaxButton(btn: MaxSendButton): MaxInlineKeyboardButton {
  const type = btn.type ?? (btn.url ? "link" : "callback");
  switch (type) {
    case "link":
      return { type: "link", text: btn.text, url: btn.url ?? "" };
    case "message":
      return { type: "message", text: btn.text, ...(btn.payload ? { payload: btn.payload } : {}) };
    case "clipboard":
      return { type: "clipboard", text: btn.text, payload: btn.payload ?? btn.text };
    case "open_app":
      return {
        type: "open_app",
        text: btn.text,
        ...(btn.webApp ? { web_app: btn.webApp } : {}),
        ...(btn.url ? { url: btn.url } : {}),
      };
    case "request_contact":
      return { type: "request_contact", text: btn.text };
    case "request_geo_location":
      return { type: "request_geo_location", text: btn.text };
    case "callback":
    default:
      return {
        type: "callback",
        text: btn.text,
        payload: btn.payload ?? btn.callback_data ?? btn.text,
        ...(btn.intent ? { intent: btn.intent } : {}),
      };
  }
}

function buildInlineKeyboard(buttons: MaxSendButton[][]): MaxInlineKeyboardAttachment {
  return {
    type: "inline_keyboard",
    payload: {
      buttons: buttons.map((row) => row.map((btn) => buildMaxButton(btn))),
    },
  };
}

/** Apply MAX markdown dialect conversion when sending formatted text. */
function formatOutboundText(text: string, format?: "markdown" | "html"): string {
  if (format === "markdown" && text) return toMaxMarkdown(text);
  return text;
}

function buildMaxTextBody(text: string, opts: MaxSendOptions = {}): MaxNewMessageBody {
  const formatted = formatOutboundText(text, opts.format);
  const body: MaxNewMessageBody = {
    text: formatted || undefined,
    format: opts.format ?? undefined,
    notify: opts.notify,
  };

  // Reply context
  if (opts.replyToMessageId) {
    body.link = { type: "reply", mid: opts.replyToMessageId };
  }

  // Inline keyboard from buttons
  if (opts.buttons?.length) {
    body.attachments = [buildInlineKeyboard(opts.buttons)];
  }

  return body;
}

function buildSendParams(
  target: MaxSendTarget,
  opts: MaxSendOptions,
): { chat_id?: number; user_id?: number; disable_link_preview?: boolean } {
  const params: { chat_id?: number; user_id?: number; disable_link_preview?: boolean } = { ...target };
  if (opts.disableLinkPreview) {
    params.disable_link_preview = true;
  }
  return params;
}

/**
 * Send a text message to a MAX chat or user.
 */
export async function sendMaxMessage(
  to: string,
  text: string,
  opts: MaxSendOptions = {},
): Promise<{ messageId: string; raw: MaxSendResult }> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });

  const target = await resolveMaxTarget(api, to);
  const body = buildMaxTextBody(text, opts);
  const result = await api.sendMessage(body, buildSendParams(target, opts));

  return {
    messageId: result.message?.body?.mid ?? "",
    raw: result,
  };
}

/**
 * Answer a MAX callback. Unlike /messages, /answers is scoped by callback_id
 * and works even when the callback update does not expose a sendable chat_id.
 */
export async function answerMaxCallback(
  callbackId: string,
  text: string,
  opts: MaxSendOptions & { notification?: string } = {},
): Promise<void> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });
  const body = buildMaxTextBody(text, opts);
  await api.answerCallback(callbackId, {
    ...(text || opts.buttons?.length ? { message: body } : {}),
    ...(opts.notification ? { notification: opts.notification } : {}),
  });
}

/**
 * Edit an existing MAX message.
 */
export async function editMaxMessage(
  messageId: string,
  text: string,
  opts: MaxSendOptions = {},
): Promise<void> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });

  await api.editMessage(messageId, {
    text: formatOutboundText(text, opts.format),
    format: opts.format ?? undefined,
  });
}

/**
 * Delete a MAX message.
 */
export async function deleteMaxMessage(
  messageId: string,
  opts: MaxSendOptions = {},
): Promise<void> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });

  await api.deleteMessage(messageId);
}

/**
 * Pin/unpin a message in a MAX chat.
 */
export async function pinMaxMessage(
  to: string,
  messageId: string,
  opts: MaxSendOptions & { pinNotify?: boolean } = {},
): Promise<void> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });
  const target = await resolveMaxTarget(api, to);
  if (!("chat_id" in target)) throw new Error("MAX pin requires a chat id target");
  await api.pinMessage(target.chat_id, messageId, opts.pinNotify);
}

export async function unpinMaxMessage(
  to: string,
  opts: MaxSendOptions = {},
): Promise<void> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });
  const target = await resolveMaxTarget(api, to);
  if (!("chat_id" in target)) throw new Error("MAX unpin requires a chat id target");
  await api.unpinMessage(target.chat_id);
}

// Extension → upload type routing. Everything else goes as a generic file.
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp"];
const VIDEO_EXTENSIONS = ["mp4", "mov", "avi", "mkv", "webm"];
const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus"];

export function detectMaxMediaType(mediaPath: string): "image" | "video" | "audio" | "file" {
  const ext = mediaPath.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (VIDEO_EXTENSIONS.includes(ext)) return "video";
  if (AUDIO_EXTENSIONS.includes(ext)) return "audio";
  return "file";
}

function isAttachmentNotReady(err: unknown): boolean {
  if (!(err instanceof MaxApiError)) return false;
  if (err.code === "attachment.not.ready") return true;
  const message = typeof (err.body as { message?: unknown })?.message === "string"
    ? String((err.body as { message?: unknown }).message)
    : "";
  return /not\s*\.?\s*ready|not processed/i.test(message);
}

/**
 * Send a media message to MAX (with upload).
 * MAX processes video/file uploads asynchronously — sendMessage may answer
 * attachment.not.ready for a few seconds; retry the send (not the upload).
 * @param to Chat ID or user ID
 * @param caption Text caption
 * @param mediaPath Local file path or URL
 * @param opts Send options
 */
export async function sendMaxMediaMessage(
  to: string,
  caption: string,
  mediaPath: string,
  opts: MaxSendOptions = {},
): Promise<{ messageId: string; raw: MaxSendResult }> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });

  const mediaType = detectMaxMediaType(mediaPath);

  // Upload media
  const uploadResult = await api.uploadMedia(mediaType, mediaPath);

  // Build attachment — MAX requires token from upload response
  const attachments: MaxAttachment[] = [
    {
      type: mediaType,
      payload: { token: uploadResult.token },
    },
  ];

  // Add inline keyboard if present
  if (opts.buttons?.length) {
    attachments.push(buildInlineKeyboard(opts.buttons) as unknown as MaxAttachment);
  }

  const body: MaxNewMessageBody = {
    text: formatOutboundText(caption, opts.format) || undefined,
    format: opts.format ?? undefined,
    notify: opts.notify,
    attachments,
  };

  if (opts.replyToMessageId) {
    body.link = { type: "reply", mid: opts.replyToMessageId };
  }

  const target = await resolveMaxTarget(api, to);
  const params = buildSendParams(target, opts);

  const result = await retryAsync(() => api.sendMessage(body, params), {
    attempts: 6,
    minDelayMs: 1_500,
    maxDelayMs: 4_000,
    label: "MAX send media (attachment.not.ready)",
    shouldRetry: (err) => isAttachmentNotReady(err),
  });

  return {
    messageId: result.message?.body?.mid ?? "",
    raw: result,
  };
}

/**
 * Send a contact attachment to MAX.
 */
export async function sendMaxContact(
  to: string,
  contact: { name: string; contactId?: number; vcfPhone?: string; vcfInfo?: string },
  opts: MaxSendOptions = {},
): Promise<{ messageId: string; raw: MaxSendResult }> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });

  // MAX API requires either contactId (MAX user_id) or vcfInfo (VCard string)
  // Without either, returns 400 "Missing info for contact attachment"
  const payload: Record<string, unknown> = {};
  if (contact.contactId != null) {
    payload.contactId = contact.contactId;
    if (contact.vcfPhone) payload.vcfPhone = contact.vcfPhone;
  } else if (contact.vcfInfo) {
    payload.vcfInfo = contact.vcfInfo;
  } else {
    // Generate VCard from name + phone
    // Use literal \n escape sequence for JSON serialization
    const vcfParts = ["BEGIN:VCARD", "VERSION:3.0", `FN:${contact.name}`];
    if (contact.vcfPhone) vcfParts.push(`TEL:${contact.vcfPhone}`);
    vcfParts.push("END:VCARD");
    payload.vcfInfo = vcfParts.join("\n");
  }

  const attachment: MaxAttachment = {
    type: "contact",
    payload,
  };

  const body: MaxNewMessageBody = {
    attachments: [attachment],
    notify: opts.notify,
  };

  if (opts.replyToMessageId) {
    body.link = { type: "reply", mid: opts.replyToMessageId };
  }

  const target = await resolveMaxTarget(api, to);
  const result = await api.sendMessage(body, buildSendParams(target, opts));

  return {
    messageId: result.message?.body?.mid ?? "",
    raw: result,
  };
}

/**
 * Send a location attachment to MAX.
 */
export async function sendMaxLocation(
  to: string,
  location: { latitude: number; longitude: number },
  text?: string,
  opts: MaxSendOptions = {},
): Promise<{ messageId: string; raw: MaxSendResult }> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });

  const attachment: MaxAttachment = {
    type: "location",
    latitude: location.latitude,
    longitude: location.longitude,
  };

  const body: MaxNewMessageBody = {
    text: formatOutboundText(text ?? "", opts.format) || undefined,
    attachments: [attachment],
    format: opts.format ?? undefined,
    notify: opts.notify,
  };

  if (opts.replyToMessageId) {
    body.link = { type: "reply", mid: opts.replyToMessageId };
  }

  const target = await resolveMaxTarget(api, to);
  const result = await api.sendMessage(body, buildSendParams(target, opts));

  return {
    messageId: result.message?.body?.mid ?? "",
    raw: result,
  };
}

/**
 * Send a sticker to MAX by sticker code.
 * Sticker codes come from incoming sticker attachments (payload.code).
 */
export async function sendMaxSticker(
  to: string,
  stickerCode: string,
  opts: MaxSendOptions = {},
): Promise<{ messageId: string; raw: MaxSendResult }> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });

  const stickerAttachment: MaxStickerAttachment = {
    type: "sticker",
    payload: { code: stickerCode },
  };

  const body: MaxNewMessageBody = {
    attachments: [stickerAttachment],
    notify: opts.notify,
  };

  if (opts.replyToMessageId) {
    body.link = { type: "reply", mid: opts.replyToMessageId };
  }

  const target = await resolveMaxTarget(api, to);
  const result = await api.sendMessage(body, buildSendParams(target, opts));

  return {
    messageId: result.message?.body?.mid ?? "",
    raw: result,
  };
}
