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

/**
 * Send a plain-text or HTML message. Returns message_id.
 */
export async function sendText(
  token: string,
  chatId: number,
  text: string,
): Promise<string> {
  const result = await sendMessage(token, chatId, {
    text,
    format: "html",
  });
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
 * Upload a local file and send it with an optional text caption.
 * Returns the sent message_id.
 */
export async function sendLocalFile(
  token: string,
  chatId: number,
  filePath: string,
  caption?: string,
): Promise<string> {
  const mimeType = getMimeType(filePath);
  const uploadType = getUploadType(mimeType);
  const filename = path.basename(filePath);

  // Step 1: obtain upload URL
  const uploadInfo = await getUploadUrl(token, uploadType);

  // Step 2: PUT the file content
  const fileContent = fs.readFileSync(filePath);
  await uploadFile(uploadInfo.url, fileContent, mimeType);

  // Step 3: send message referencing the uploaded token
  const attachmentType =
    uploadType === "image"
      ? "image"
      : uploadType === "video"
        ? "video"
        : uploadType === "audio"
          ? "audio"
          : "file";

  const body: SendMessageBody = {
    attachments: [
      {
        type: attachmentType,
        payload: {
          token: uploadInfo.token ?? uploadInfo.url,
          filename,
        },
      },
    ],
  };
  if (caption) body.text = caption;

  const result = await sendMessage(token, chatId, body);
  return result.message_id;
}
