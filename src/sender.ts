/**
 * MAX Bot API — high-level send helpers
 * Compatible with types from types.ts (Банзай)
 */
import * as fs from "node:fs";
import * as path from "node:path";
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
    format: options?.format ?? "html",
  };
  if (options?.replyTo) {
    body.link = { type: "reply", mid: options.replyTo };
  }
  if (options?.disableLinkPreview) {
    body.disable_link_preview = true;
  }
  const result = await sendMessage(token, chatId, body);
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
  await editMessage(token, messageId, { text, format: "html" });
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

  if (uploadType === "file" && !normalized.filename) {
    normalized.filename = filename;
  }

  return normalized;
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

  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) {
      await sleep(500 * 2 ** (attempt - 1));
    }

    const body: SendMessageBody = {
      attachments: [
        {
          type: attachmentType,
          payload: buildAttachmentPayload(uploadType, uploadPayload, filename),
        },
      ],
    };
    if (caption) body.text = caption;
    if (replyTo) body.link = { type: "reply", mid: replyTo };

    try {
      const result = await sendMessage(token, chatId, body);
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
