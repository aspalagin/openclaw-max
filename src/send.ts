/**
 * Outbound message sending for MAX.
 */

import {
  MaxApi,
  type MaxNewMessageBody,
  type MaxSendResult,
  type MaxInlineKeyboardAttachment,
  type MaxStickerAttachment,
  type MaxAttachment,
} from "./api.js";
import { resolveMaxAccount } from "./accounts.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

export interface MaxSendOptions {
  token?: string;
  accountId?: string;
  cfg?: OpenClawConfig;
  replyToMessageId?: string;
  format?: "markdown" | "html";
  disableLinkPreview?: boolean;
  notify?: boolean;
  buttons?: Array<Array<{ text: string; payload?: string; url?: string }>>;
}

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
 * Send a text message to a MAX chat or user.
 */
export async function sendMaxMessage(
  to: string,
  text: string,
  opts: MaxSendOptions = {},
): Promise<{ messageId: string; raw: MaxSendResult }> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });

  const chatId = Number(to);
  const isUserId = !Number.isNaN(chatId);

  // Build message body
  const body: MaxNewMessageBody = {
    text: text || undefined,
    format: opts.format ?? undefined,
    notify: opts.notify,
  };

  // Reply context
  if (opts.replyToMessageId) {
    body.link = { type: "reply", mid: opts.replyToMessageId };
  }

  // Inline keyboard from buttons
  if (opts.buttons?.length) {
    const keyboard: MaxInlineKeyboardAttachment = {
      type: "inline_keyboard",
      payload: {
        buttons: opts.buttons.map((row) =>
          row.map((btn) => {
            if (btn.url) {
              return { type: "link" as const, text: btn.text, url: btn.url };
            }
            return {
              type: "callback" as const,
              text: btn.text,
              payload: btn.payload ?? btn.text,
            };
          }),
        ),
      },
    };
    body.attachments = [keyboard];
  }

  // Determine params
  const params: { chat_id?: number; user_id?: number; disable_link_preview?: boolean } = {};

  if (isUserId) {
    // Could be either chat_id or user_id. For DMs, prefer chat_id if negative or large.
    // MAX uses positive IDs for both users and chats.
    // Convention: if we have a chat_id from an inbound message, use chat_id.
    // For now, try chat_id first, fall back to user_id.
    params.chat_id = chatId;
  }

  if (opts.disableLinkPreview) {
    params.disable_link_preview = true;
  }

  const result = await api.sendMessage(body, params);

  return {
    messageId: result.message?.body?.mid ?? "",
    raw: result,
  };
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
    text,
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
 * Send a media message to MAX (with upload).
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

  // Detect media type from path
  const ext = mediaPath.split(".").pop()?.toLowerCase();
  let mediaType: "image" | "video" | "audio" | "file" = "file";
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext ?? "")) {
    mediaType = "image";
  } else if (["mp4", "mov", "avi"].includes(ext ?? "")) {
    mediaType = "video";
  } else if (["mp3", "wav", "ogg"].includes(ext ?? "")) {
    mediaType = "audio";
  }

  // Upload media
  const uploadResult = await api.uploadMedia(mediaType, mediaPath);

  // Build attachment — MAX requires token from upload response
  const attachments: MaxAttachment[] = [
    {
      type: mediaType === "image" ? "image" : mediaType === "video" ? "video" : mediaType === "audio" ? "audio" : "file",
      payload: { token: uploadResult.token },
    },
  ];

  // Add inline keyboard if present
  if (opts.buttons?.length) {
    attachments.push({
      type: "inline_keyboard",
      payload: {
        buttons: opts.buttons.map((row) =>
          row.map((btn) => {
            if (btn.url) {
              return { type: "link" as const, text: btn.text, url: btn.url };
            }
            return {
              type: "callback" as const,
              text: btn.text,
              payload: btn.payload ?? btn.text,
            };
          }),
        ),
      },
    });
  }

  const body: MaxNewMessageBody = {
    text: caption || undefined,
    format: opts.format ?? undefined,
    notify: opts.notify,
    attachments,
  };

  if (opts.replyToMessageId) {
    body.link = { type: "reply", mid: opts.replyToMessageId };
  }

  const chatId = Number(to);
  const params: { chat_id?: number; user_id?: number; disable_link_preview?: boolean } = {
    chat_id: chatId,
  };

  if (opts.disableLinkPreview) {
    params.disable_link_preview = true;
  }

  const result = await api.sendMessage(body, params);

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
    text: opts.disableLinkPreview ? undefined : undefined, // no separate text for contact
    attachments: [attachment],
    notify: opts.notify,
  };

  if (opts.replyToMessageId) {
    body.link = { type: "reply", mid: opts.replyToMessageId };
  }

  const chatId = Number(to);
  const result = await api.sendMessage(body, { chat_id: chatId });

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
    text: text || undefined,
    attachments: [attachment],
    format: opts.format ?? undefined,
    notify: opts.notify,
  };

  if (opts.replyToMessageId) {
    body.link = { type: "reply", mid: opts.replyToMessageId };
  }

  const chatId = Number(to);
  const result = await api.sendMessage(body, { chat_id: chatId });

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

  const chatId = Number(to);
  const params: { chat_id?: number; disable_link_preview?: boolean } = {
    chat_id: chatId,
  };

  const result = await api.sendMessage(body, params);

  return {
    messageId: result.message?.body?.mid ?? "",
    raw: result,
  };
}
