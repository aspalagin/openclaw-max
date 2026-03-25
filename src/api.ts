/**
 * MAX Bot API — HTTP client
 * Uses types from types.ts (Банзай)
 */
import type { UpdatesResponse } from "./types.js";

export type { UpdatesResponse };

const BASE_URL = "https://platform-api.max.ru";
const MAX_RETRY_ATTEMPTS = 3;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  attempt = 0,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 65_000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("retry-after") ?? "10", 10);
      const delay = Math.min(retryAfter * 1000, 30_000);
      await sleep(delay);
      if (attempt < MAX_RETRY_ATTEMPTS) {
        return fetchWithRetry(url, options, attempt + 1);
      }
    }

    if (response.status >= 500 && attempt < MAX_RETRY_ATTEMPTS) {
      const delay = Math.pow(2, attempt) * 1000;
      await sleep(delay);
      return fetchWithRetry(url, options, attempt + 1);
    }

    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

function makeHeaders(token: string): Record<string, string> {
  return {
    Authorization: token,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// ─── Send message ────────────────────────────────────────────────

export interface SendMessageBody {
  text?: string;
  format?: "html" | "markdown" | "plain";
  attachments?: Array<{ type: string; payload: Record<string, unknown> }>;
  notify?: boolean;
}

export interface SendMessageResponse {
  message_id: string;
  chat_id: number;
  seq?: number;
  timestamp?: number;
}

export async function sendMessage(
  token: string,
  chatId: number,
  body: SendMessageBody,
): Promise<SendMessageResponse> {
  const response = await fetchWithRetry(
    `${BASE_URL}/messages?chat_id=${chatId}`,
    {
      method: "POST",
      headers: makeHeaders(token),
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`MAX sendMessage failed [${response.status}]: ${text}`);
  }

  return response.json() as Promise<SendMessageResponse>;
}

// ─── Edit message ────────────────────────────────────────────────

export async function editMessage(
  token: string,
  messageId: string,
  body: SendMessageBody,
): Promise<SendMessageResponse> {
  const response = await fetchWithRetry(
    `${BASE_URL}/messages?message_id=${encodeURIComponent(messageId)}`,
    {
      method: "PUT",
      headers: makeHeaders(token),
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`MAX editMessage failed [${response.status}]: ${text}`);
  }

  return response.json() as Promise<SendMessageResponse>;
}

// ─── Delete message ──────────────────────────────────────────────

export async function deleteMessage(token: string, messageId: string): Promise<void> {
  const response = await fetchWithRetry(
    `${BASE_URL}/messages?message_id=${encodeURIComponent(messageId)}`,
    {
      method: "DELETE",
      headers: makeHeaders(token),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`MAX deleteMessage failed [${response.status}]: ${text}`);
  }
}

// ─── File upload ─────────────────────────────────────────────────

export interface UploadResponse {
  url: string;
  token?: string;
}

export async function getUploadUrl(
  token: string,
  type: "image" | "file" | "video" | "audio" = "file",
): Promise<UploadResponse> {
  const response = await fetchWithRetry(
    `${BASE_URL}/uploads?type=${type}`,
    {
      method: "POST",
      headers: makeHeaders(token),
      body: "{}",
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`MAX getUploadUrl failed [${response.status}]: ${text}`);
  }

  return response.json() as Promise<UploadResponse>;
}

export async function uploadFile(
  uploadUrl: string,
  content: Buffer,
  mimeType: string,
): Promise<void> {
  const response = await fetchWithRetry(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: content as unknown as BodyInit,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`MAX file upload failed [${response.status}]: ${text}`);
  }
}

// ─── Download file ───────────────────────────────────────────────

export async function downloadFile(url: string, token: string): Promise<Buffer> {
  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: { Authorization: token },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`MAX file download failed [${response.status}]: ${text}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
