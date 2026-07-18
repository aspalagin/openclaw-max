/**
 * MAX Bot API client — thin wrapper around platform-api2.max.ru
 *
 * API docs: https://dev.max.ru/docs-api
 * Auth: Authorization header with bot token
 * Rate limit: 30 rps
 *
 * TLS: platform-api2.max.ru serves a certificate issued by the Russian Trusted
 * (Минцифры) CA, which is not in the default Node trust store. Requests go
 * through a dedicated undici dispatcher whose CA set = system roots + Russian
 * Trusted Root/Sub CA. Trust is scoped to this client only, never process-wide.
 */

import { randomBytes } from "node:crypto";
import * as tls from "node:tls";
import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import { Agent, fetch as undiciFetch } from "undici";

import { RUSSIAN_TRUSTED_ROOT_CA, RUSSIAN_TRUSTED_SUB_CA } from "./russian-trusted-ca.js";
import type {
  MaxUser,
  MaxChat,
  MaxChatMember,
  MaxMessage,
  MaxUpdate,
  MaxCallback,
  MaxNewMessageBody,
  MaxBotPatch,
  MaxSenderAction,
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
  MaxVideoInfo,
} from "./types.js";

export type {
  MaxUser,
  MaxChat,
  MaxChatMember,
  MaxMessage,
  MaxUpdate,
  MaxCallback,
  MaxNewMessageBody,
  MaxBotPatch,
  MaxSenderAction,
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
  MaxVideoInfo,
} from "./types.js";

/**
 * platform-api.max.ru is shut down on 2026-07-19; platform-api2.max.ru is the
 * canonical endpoint since June 2026.
 */
const BASE_URL = "https://platform-api2.max.ru";

// ────────────────────── HTTP transport ──────────────────────

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

let testFetchOverride: FetchLike | undefined;

/**
 * Test seam: route all MAX HTTP through the given fetch (e.g. a vi.fn or a
 * passthrough to a mocked globalThis.fetch). Pass undefined to restore.
 */
export function setMaxFetchForTests(fetchImpl: FetchLike | undefined): void {
  testFetchOverride = fetchImpl;
}

let cachedDispatcher: Agent | undefined;

function getMaxDispatcher(): Agent {
  if (!cachedDispatcher) {
    const tlsWithCaList = tls as unknown as {
      getCACertificates?: (type: string) => readonly string[];
    };
    // getCACertificates("default") includes NODE_EXTRA_CA_CERTS additions when available
    const systemCas = tlsWithCaList.getCACertificates?.("default") ?? tls.rootCertificates;
    cachedDispatcher = new Agent({
      connect: {
        ca: [...systemCas, RUSSIAN_TRUSTED_ROOT_CA, RUSSIAN_TRUSTED_SUB_CA],
      },
    });
  }
  return cachedDispatcher;
}

function maxFetch(url: string, init: Record<string, unknown>): ReturnType<FetchLike> {
  if (testFetchOverride) return testFetchOverride(url, init);
  return undiciFetch(url, {
    ...init,
    dispatcher: getMaxDispatcher(),
  } as Parameters<typeof undiciFetch>[1]) as unknown as ReturnType<FetchLike>;
}

function escapeMultipartHeaderValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, "_");
}

function buildMultipartFileBody(
  fieldName: string,
  fileName: string,
  mimeType: string,
  fileBuffer: Buffer,
): { body: Buffer; contentType: string } {
  const boundary = `----openclaw-max-${randomBytes(12).toString("hex")}`;
  const escapedField = escapeMultipartHeaderValue(fieldName);
  const escapedFile = escapeMultipartHeaderValue(fileName);
  const preamble = Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="${escapedField}"; filename="${escapedFile}"\r\n`
    + `Content-Type: ${mimeType}\r\n\r\n`,
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`);

  return {
    body: Buffer.concat([preamble, fileBuffer, closing]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// ────────────────────── API Client ──────────────────────

export interface MaxApiOptions {
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Retry attempts for transient errors (429 / 502-504 / network). 0 disables. Default 3. */
  retryAttempts?: number;
}

export class MaxApiError extends Error {
  /** MAX error code from the response body, e.g. "attachment.not.ready" */
  public code?: string;
  /** Parsed Retry-After (ms), when the response carried one */
  public retryAfterMs?: number;

  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "MaxApiError";
    if (body && typeof body === "object") {
      const code = (body as Record<string, unknown>).code;
      if (typeof code === "string") this.code = code;
    }
  }
}

/**
 * Whether an error is safe to retry. `idempotent` gates the ambiguous cases:
 * for non-idempotent calls (POST /messages, POST /answers) a 5xx or network
 * failure may mean the request WAS applied server-side, so retrying would
 * duplicate the message — only a definite 429 (never applied) is retried.
 */
function isRetryableError(err: unknown, idempotent: boolean): boolean {
  if (err instanceof MaxApiError) {
    if (err.status === 429) return true; // rate-limited: request was rejected, safe to retry
    // 500 excluded everywhere: the request may have been applied.
    if (err.status === 502 || err.status === 503 || err.status === 504) return idempotent;
    return false;
  }
  if (err instanceof Error && err.name === "AbortError") return false;
  // undici network-level failure (fetch failed, ECONNRESET, socket hang up…):
  // ambiguous — the request may have reached the server, so retry only if idempotent.
  return idempotent && (err instanceof TypeError || err instanceof Error);
}

const IDEMPOTENT_METHODS = new Set(["GET", "PUT", "DELETE"]);

export class MaxApi {
  private token: string;
  private baseUrl: string;
  private timeoutMs: number;
  private retryAttempts: number;

  constructor(opts: MaxApiOptions) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    const envAttempts = Number(process.env.OPENCLAW_MAX_RETRY_ATTEMPTS);
    this.retryAttempts = opts.retryAttempts
      ?? (Number.isFinite(envAttempts) && envAttempts >= 0 ? envAttempts : 3);
  }

  // ── HTTP helpers ──

  private async requestOnce<T>(
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
      const res = await maxFetch(url.toString(), {
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
        // Never log the request body: it may carry the webhook secret (POST
        // /subscriptions) or private message text. Log only method+path+status.
        console.error(`[MAX API] ${method} ${path} → ${res.status}`);
        const error = new MaxApiError(
          `MAX API ${method} ${path} → ${res.status}`,
          res.status,
          json,
        );
        const retryAfter = res.headers?.get?.("retry-after");
        if (retryAfter) {
          const seconds = Number(retryAfter);
          if (Number.isFinite(seconds) && seconds > 0) error.retryAfterMs = seconds * 1000;
        }
        throw error;
      }

      return json;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async request<T>(
    method: string,
    path: string,
    params?: Record<string, string | number | boolean | undefined | null>,
    body?: unknown,
    timeoutMs?: number,
    retryAttempts?: number,
  ): Promise<T> {
    const attempts = retryAttempts ?? this.retryAttempts;
    if (attempts <= 1) {
      return this.requestOnce<T>(method, path, params, body, timeoutMs);
    }
    const idempotent = IDEMPOTENT_METHODS.has(method);
    return retryAsync(() => this.requestOnce<T>(method, path, params, body, timeoutMs), {
      attempts,
      minDelayMs: 500,
      maxDelayMs: 5_000,
      label: `MAX ${method} ${path}`,
      shouldRetry: (err) => isRetryableError(err, idempotent),
      retryAfterMs: (err) => (err instanceof MaxApiError ? err.retryAfterMs : undefined),
    });
  }

  // ── Bot info ──

  async getMe(): Promise<MaxUser> {
    return this.request<MaxUser>("GET", "/me");
  }

  /** Update bot info: name, description, avatar, commands (PATCH /me). */
  async editMyInfo(patch: MaxBotPatch): Promise<MaxUser> {
    return this.request<MaxUser>("PATCH", "/me", undefined, patch);
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

  /** Get chat by numeric id or by public link/username (GET /chats/{chatLink}). */
  async getChat(chatIdOrLink: number | string): Promise<MaxChat> {
    const ref = typeof chatIdOrLink === "string"
      ? encodeURIComponent(chatIdOrLink.replace(/^@/, ""))
      : chatIdOrLink;
    return this.request("GET", `/chats/${ref}`);
  }

  /** Bot's own membership in a chat — is_admin matters: long polling delivers group updates only to admin bots. */
  async getMembership(chatId: number): Promise<MaxChatMember> {
    return this.request("GET", `/chats/${chatId}/members/me`);
  }

  // ── Pinned messages ──

  async getPinnedMessage(chatId: number): Promise<{ message?: MaxMessage | null }> {
    return this.request("GET", `/chats/${chatId}/pin`);
  }

  async pinMessage(chatId: number, messageId: string, notify?: boolean): Promise<MaxSimpleResult> {
    return this.request("PUT", `/chats/${chatId}/pin`, undefined, {
      message_id: messageId,
      ...(notify != null ? { notify } : {}),
    });
  }

  async unpinMessage(chatId: number): Promise<MaxSimpleResult> {
    return this.request("DELETE", `/chats/${chatId}/pin`);
  }

  // ── Chat actions ──

  async sendAction(chatId: number, action: MaxSenderAction): Promise<MaxSimpleResult> {
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

    // Long polling needs a longer timeout; the polling loop owns retries
    const pollTimeout = ((params?.timeout ?? 30) + 5) * 1000;
    return this.request("GET", "/updates", qp, undefined, pollTimeout, 0);
  }

  // ── Videos ──

  /** Playback info for an inbound video attachment (GET /videos/{videoToken}). */
  async getVideoInfo(videoToken: string): Promise<MaxVideoInfo> {
    return this.request("GET", `/videos/${encodeURIComponent(videoToken)}`);
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

  /**
   * Register bot commands. MAX has no dedicated commands endpoint — commands
   * are part of bot info and updated via PATCH /me. Limits: 32 commands,
   * name ≤ 64 chars (no leading slash), description ≤ 128 chars.
   */
  async setMyCommands(commands: MaxBotCommand[]): Promise<MaxUser> {
    const normalized = commands
      .map((cmd) => ({
        name: cmd.name.replace(/^\//, "").slice(0, 64),
        ...(cmd.description ? { description: cmd.description.slice(0, 128) } : {}),
      }))
      .filter((cmd) => cmd.name.length > 0)
      .slice(0, 32);
    return this.editMyInfo({ commands: normalized });
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
          heic: "image/heic",
          heif: "image/heif",
          tif: "image/tiff",
          tiff: "image/tiff",
          bmp: "image/bmp",
          mp4: "video/mp4",
          mov: "video/quicktime",
          avi: "video/x-msvideo",
          mkv: "video/x-matroska",
          webm: "video/webm",
          mp3: "audio/mpeg",
          wav: "audio/wav",
          ogg: "audio/ogg",
          m4a: "audio/mp4",
          aac: "audio/aac",
          flac: "audio/flac",
          opus: "audio/opus",
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

    // Step 3: POST file as multipart/form-data to upload URL. MAX upload hosts
    // reject Node's native FormData in some cases with 412, while curl-style
    // multipart with a known Content-Length is accepted.
    const multipart = buildMultipartFileBody("data", fileName, mimeType, fileBuffer);

    const uploadRes = await maxFetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": multipart.contentType,
        "Content-Length": String(multipart.body.byteLength),
      },
      body: multipart.body,
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
    // Video/audio/file may respond with a top-level token or a similar nested map
    const result = (await uploadRes.json().catch(() => ({}))) as Record<string, unknown>;

    // Try to find token from nested response structure
    let token = typeof uploadInfo.token === "string" ? uploadInfo.token : "";
    let url: string | undefined;

    let foundNested = false;
    const nestedContainers = ["photos", "videos", "audios", "files"] as const;
    for (const key of nestedContainers) {
      const container = result[key];
      if (container && typeof container === "object" && !Array.isArray(container)) {
        const first = Object.values(container as Record<string, { token?: string; url?: string }>)[0];
        if (first?.token) {
          token = first.token;
          url = first.url;
          foundNested = true;
          break;
        }
      }
    }
    if (!foundNested && result.token && typeof result.token === "string") {
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
