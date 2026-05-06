/**
 * MAX Bot API — high-level send helpers
 * Compatible with types from types.ts (Банзай)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fetch } from "undici";
import {
  deleteMessage,
  editMessage,
  getUploadUrl,
  sendMessage,
  uploadFile,
  type SendMessageBody,
  type UploadedAttachmentPayload,
} from "./api.js";

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

function getUploadType(mimeType: string): "image" | "file" | "video" | "audio" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

/** Options for sendText */
export interface SendTextOptions {
  /** Reply to a specific message */
  replyTo?: string;
  /** Text format: "html" (default), "markdown", or "plain" */
  format?: "html" | "markdown" | "plain";
  /** Disable link preview */
  disableLinkPreview?: boolean;
  /** Send to chat_id (default) or user_id */
  targetMode?: "chat" | "user";
}

/**
 * Send a plain-text or HTML message. Returns message_id.
 */
export async function sendText(
  token: string,
  chatId: number,
  text: string,
  options?: SendTextOptions,
): Promise<string> {
  const body: SendMessageBody = {
    text,
    format: options?.format ?? "markdown",
  };
  if (options?.replyTo) {
    body.link = { type: "reply", mid: options.replyTo };
  }
  if (options?.disableLinkPreview) {
    body.disable_link_preview = true;
  }
  const result = await sendMessage(token, chatId, body, options?.targetMode);
  return result.message_id;
}

/**
 * Edit an existing message in place (used for streaming).
 */
export async function editText(
  token: string,
  messageId: string,
  text: string,
): Promise<void> {
  await editMessage(token, messageId, { text, format: "markdown" });
}

/**
 * Delete a message silently (ignores errors).
 */
export async function removeMessage(token: string, messageId: string): Promise<void> {
  try {
    await deleteMessage(token, messageId);
  } catch {
    // Non-fatal — message may already be gone
  }
}

/**
 * Forward a message to another chat.
 * Uses the link.type: "forward" mechanism.
 * Returns the sent message_id.
 */
export async function forwardMessage(
  token: string,
  chatId: number,
  originalMid: string,
): Promise<string> {
  const body: SendMessageBody = {
    link: { type: "forward", mid: originalMid },
  };
  const result = await sendMessage(token, chatId, body);
  return result.message_id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAttachmentPayload(
  uploadType: "image" | "file" | "video" | "audio",
  payload: UploadedAttachmentPayload,
  filename: string,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...payload };

  if (typeof normalized.fileId === "number" && normalized.file_id === undefined) {
    normalized.file_id = normalized.fileId;
  }

  delete normalized.fileId;

  if (uploadType === "file" && !normalized.filename) {
    normalized.filename = filename;
  }

  return normalized;
}

async function waitForUploadedAttachment(
  token: string,
  chatId: number,
  attachmentType: string,
  payload: Record<string, unknown>,
  filename: string,
  targetMode: "chat" | "user" = "chat",
): Promise<void> {
  const body: SendMessageBody = {
    attachments: [
      {
        type: attachmentType,
        payload: {
          ...payload,
          filename,
        },
      },
    ],
    notify: false,
  };

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) {
      await sleep(750 * 2 ** Math.min(attempt - 1, 3));
    }

    const response = await fetch(
      `https://platform-api.max.ru/messages?${targetMode === "user" ? "user_id" : "chat_id"}=${chatId}`,
      {
        method: "POST",
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    if (response.ok) {
      const data = await response.json().catch(() => null) as { message_id?: string } | null;
      if (data?.message_id) {
        await removeMessage(token, data.message_id);
      }
      return;
    }

    const text = await response.text().catch(() => "");
    if (!text.includes("attachment.not.ready")) {
      return;
    }
  }
}

/**
 * Upload a local file and send it with an optional text caption.
 * Returns the sent message_id.
 */
export async function sendLocalFile(
  token: string,
  chatId: number,
  filePath: string,
  caption?: string,
  replyTo?: string,
  targetMode: "chat" | "user" = "chat",
): Promise<string> {
  const mimeType = getMimeType(filePath);
  const uploadType = getUploadType(mimeType);
  const filename = path.basename(filePath);

  const uploadInfo = await getUploadUrl(token, uploadType);
  const fileContent = fs.readFileSync(filePath);
  const uploadPayload = await uploadFile(token, uploadInfo.url, fileContent, filename, mimeType);

  const attachmentType =
    uploadType === "image"
      ? "image"
      : uploadType === "video"
        ? "video"
        : uploadType === "audio"
          ? "audio"
          : "file";

  const attachmentPayload = buildAttachmentPayload(uploadType, uploadPayload, filename);
  await waitForUploadedAttachment(token, chatId, attachmentType, attachmentPayload, filename, targetMode);

  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) {
      await sleep(500 * 2 ** (attempt - 1));
    }

    const body: SendMessageBody = {
      attachments: [
        {
          type: attachmentType,
          payload: attachmentPayload,
        },
      ],
    };
    if (caption) body.text = caption;
    if (replyTo) body.link = { type: "reply", mid: replyTo };

    try {
      const result = await sendMessage(token, chatId, body, targetMode);
      return result.message_id;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("attachment.not.ready") || attempt === 3) {
        throw err;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
