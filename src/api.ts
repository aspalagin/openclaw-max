/**
 * MAX Bot API client — thin wrapper around platform-api.max.ru
 *
 * API docs: https://dev.max.ru/docs-api
 * Auth: Authorization header with bot token
 * Rate limit: 30 rps
 */

import type {
  MaxUser,
  MaxChat,
  MaxMessage,
  MaxUpdate,
  MaxCallback,
  MaxNewMessageBody,
  MaxSendResult,
  MaxSimpleResult,
  MaxSubscription,
  MaxSubscriptionsResponse,
  MaxUploadUrlResponse,
  MaxInlineKeyboardButton,
  MaxInlineKeyboardAttachment,
  MaxStickerAttachment,
  MaxBotCommand,
  MaxUpdateType,
  MaxUpdatesResponse,
  MaxAttachment,
  MaxRecipient,
  MaxMessageBody,
  MaxLinkedMessage,
  MaxUploadResult,
} from "./types.js";

export type {
  MaxUser,
  MaxChat,
  MaxMessage,
  MaxUpdate,
  MaxCallback,
  MaxNewMessageBody,
  MaxSendResult,
  MaxSimpleResult,
  MaxSubscription,
  MaxSubscriptionsResponse,
  MaxUploadUrlResponse,
  MaxInlineKeyboardButton,
  MaxInlineKeyboardAttachment,
  MaxStickerAttachment,
  MaxBotCommand,
  MaxUpdateType,
  MaxUpdatesResponse,
  MaxAttachment,
  MaxRecipient,
  MaxMessageBody,
  MaxLinkedMessage,
  MaxUploadResult,
} from "./types.js";

const BASE_URL = "https://platform-api.max.ru";

// ────────────────────── API Client ──────────────────────

export interface MaxApiOptions {
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class MaxApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "MaxApiError";
  }
}

export class MaxApi {
  private token: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(opts: MaxApiOptions) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  // ── HTTP helpers ──

  private async request<T>(
    method: string,
    path: string,
    params?: Record<string, string | number | boolean | undefined | null>,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v != null) url.searchParams.set(k, String(v));
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs ?? this.timeoutMs,
    );

    try {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: this.token,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const json = (await res.json().catch(() => null)) as T;

      if (!res.ok) {
        const errDetail = json ? JSON.stringify(json) : "(no body)";
        const bodyDetail = body ? JSON.stringify(body) : "(no body)";
        console.error(`[MAX API] ${method} ${path} → ${res.status}: ${errDetail}\n  Request body: ${bodyDetail}`);
        throw new MaxApiError(
          `MAX API ${method} ${path} → ${res.status}`,
          res.status,
          json,
        );
      }

      return json;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Bot info ──

  async getMe(): Promise<MaxUser> {
    return this.request<MaxUser>("GET", "/me");
  }

  // ── Messages ──

  async sendMessage(
    body: MaxNewMessageBody,
    params: { chat_id?: number; user_id?: number; disable_link_preview?: boolean },
  ): Promise<MaxSendResult> {
    return this.request<MaxSendResult>("POST", "/messages", params as Record<string, string | number>, body);
  }

  async editMessage(
    messageId: string,
    body: MaxNewMessageBody,
  ): Promise<MaxSimpleResult> {
    return this.request<MaxSimpleResult>("PUT", "/messages", { message_id: messageId }, body);
  }

  async deleteMessage(messageId: string): Promise<MaxSimpleResult> {
    return this.request<MaxSimpleResult>("DELETE", "/messages", { message_id: messageId });
  }

  async getMessages(chatId: number, params?: {
    message_ids?: string[];
    from?: number;
    to?: number;
    count?: number;
  }): Promise<{ messages: MaxMessage[] }> {
    const qp: Record<string, string | number> = { chat_id: chatId };
    if (params?.message_ids) qp.message_ids = params.message_ids.join(",");
    if (params?.from) qp.from = params.from;
    if (params?.to) qp.to = params.to;
    if (params?.count) qp.count = params.count;
    return this.request("GET", "/messages", qp);
  }

  // ── Chats ──

  async getChats(params?: { count?: number; marker?: number }): Promise<{ chats: MaxChat[]; marker: number | null }> {
    return this.request("GET", "/chats", params as Record<string, string | number>);
  }

  async getChat(chatId: number): Promise<MaxChat> {
    return this.request("GET", `/chats/${chatId}`);
  }

  // ── Chat actions ──

  async sendAction(chatId: number, action: "typing_on" | "sending_photo" | "sending_video" | "sending_audio" | "sending_file" | "mark_seen"): Promise<MaxSimpleResult> {
    return this.request("POST", `/chats/${chatId}/actions`, undefined, { action });
  }

  // ── Callbacks ──

  async answerCallback(callbackId: string, body?: { message?: MaxNewMessageBody; notification?: string }): Promise<MaxSimpleResult> {
    return this.request("POST", "/answers", { callback_id: callbackId }, body);
  }

  // ── Updates (long polling) ──

  async getUpdates(params?: {
    limit?: number;
    timeout?: number;
    marker?: number | null;
    types?: MaxUpdateType[];
  }): Promise<MaxUpdatesResponse> {
    const qp: Record<string, string | number> = {};
    if (params?.limit) qp.limit = params.limit;
    if (params?.timeout != null) qp.timeout = params.timeout;
    if (params?.marker != null) qp.marker = params.marker;
    if (params?.types?.length) qp.types = params.types.join(",");

    // Long polling needs a longer timeout
    const pollTimeout = ((params?.timeout ?? 30) + 5) * 1000;
    return this.request("GET", "/updates", qp, undefined, pollTimeout);
  }

  // ── Subscriptions (webhooks) ──

  async getSubscriptions(): Promise<MaxSubscriptionsResponse> {
    return this.request("GET", "/subscriptions");
  }

  async subscribe(params: {
    url: string;
    update_types?: string[];
    secret?: string;
  }): Promise<MaxSimpleResult> {
    return this.request("POST", "/subscriptions", undefined, params);
  }

  async unsubscribe(subscriptionUrl: string): Promise<MaxSimpleResult> {
    return this.request("DELETE", "/subscriptions", { url: subscriptionUrl });
  }

  // ── Commands ──

  async setMyCommands(commands: MaxBotCommand[]): Promise<MaxSimpleResult> {
    return this.request("POST", "/me/commands", undefined, { commands });
  }

  // ── Upload ──

  async getUploadUrl(type: "image" | "video" | "audio" | "file"): Promise<MaxUploadUrlResponse> {
    return this.request("POST", `/uploads`, { type });
  }

  /**
   * Upload media file to MAX.
   * MAX upload requires multipart/form-data with field "data".
   * Response contains a token (in photos/videos/etc) to use in attachments.
   *
   * @param type Media type (image, video, audio, file)
   * @param data File path (string) or buffer (Buffer/Uint8Array)
   * @param contentType MIME type (optional, auto-detected for common types)
   * @returns Upload result with token (for use in attachment payload)
   */
  async uploadMedia(
    type: "image" | "video" | "audio" | "file",
    data: string | Buffer | Uint8Array,
    contentType?: string,
  ): Promise<{ token: string; url?: string }> {
    // Step 1: Get upload URL and attachment token.
    // MAX returns the attachment token together with the upload URL. The
    // following upload host may answer with XML like `<retval>1</retval>` and
    // does not repeat that token.
    const uploadInfo = await this.getUploadUrl(type);
    const uploadUrl = uploadInfo.url;

    // Step 2: Load file if data is a path
    let fileBuffer: Buffer;
    let mimeType = contentType;
    let fileName = "file";

    if (typeof data === "string") {
      // File path — read from disk
      const fs = await import("fs/promises");
      const path = await import("path");
      fileBuffer = await fs.readFile(data);
      fileName = path.basename(data);

      // Auto-detect MIME type if not provided
      if (!mimeType) {
        const ext = data.split(".").pop()?.toLowerCase();
        const mimeMap: Record<string, string> = {
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          png: "image/png",
          gif: "image/gif",
          webp: "image/webp",
          mp4: "video/mp4",
          mov: "video/quicktime",
          avi: "video/x-msvideo",
          mp3: "audio/mpeg",
          wav: "audio/wav",
          ogg: "audio/ogg",
          pdf: "application/pdf",
          txt: "text/plain",
        };
        mimeType = ext ? mimeMap[ext] : "application/octet-stream";
      }
    } else {
      // Already a buffer
      fileBuffer = Buffer.from(data);
      mimeType = mimeType ?? "application/octet-stream";
    }

    // Step 3: POST file as multipart/form-data to upload URL
    const blob = new Blob([new Uint8Array(fileBuffer)], { type: mimeType });
    const formData = new FormData();
    formData.append("data", blob, fileName);

    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      body: formData,
    });

    if (!uploadRes.ok) {
      throw new MaxApiError(
        `MAX media upload failed: ${uploadRes.status}`,
        uploadRes.status,
        await uploadRes.text().catch(() => null),
      );
    }

    // Step 4: Parse response to extract token
    // Image response: { photos: { "<id>": { token: "...", url: "..." } } }
    // Video/file etc may differ
    const result = (await uploadRes.json().catch(() => ({}))) as Record<string, unknown>;

    // Try to find token from nested response structure
    let token = typeof uploadInfo.token === "string" ? uploadInfo.token : "";
    let url: string | undefined;

    if (result.photos && typeof result.photos === "object") {
      const photos = result.photos as Record<string, { token?: string; url?: string }>;
      const first = Object.values(photos)[0];
      if (first?.token) { token = first.token; url = first.url; }
    } else if (result.token && typeof result.token === "string") {
      token = result.token;
      url = (result.url as string) ?? undefined;
    }

    if (!token) {
      throw new MaxApiError(
        "MAX media upload: no token in response",
        200,
        result,
      );
    }

    return { token, url };
  }
}
