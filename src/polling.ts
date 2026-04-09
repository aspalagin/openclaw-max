/**
 * MAX Messenger Bot API — Long Polling module
 *
 * Receives updates from platform-api.max.ru via long polling.
 * Node 18+ (built-in fetch). Zero external dependencies.
 *
 * Usage:
 *   const stop = startPolling("my_token", async (update) => {
 *     console.log("New message from", update.message.sender?.user_id);
 *     console.log("Text:", update.message.body.text);
 *   });
 *   setTimeout(stop, 60_000); // stop after 60s
 */

import type { MessageCreatedUpdate, Update, UpdatesResponse } from "./types.js";

// ─── Constants ──────────────────────────────────────────────────

const API_BASE = "https://platform-api.max.ru";
const POLL_TIMEOUT_SEC = 30;
const RETRY_DELAY_NETWORK = 5_000;
const RETRY_DELAY_RATE_LIMIT = 60_000;  // 1 min — MAX rate limit window
const RETRY_DELAY_SERVER_ERROR = 15_000;
const POLL_CYCLE_DELAY_MS = 250;

// ─── Types ──────────────────────────────────────────────────────

export type MessageHandler = (update: MessageCreatedUpdate) => Promise<void>;

/** Generic handler for any update type */
export type UpdateHandler = (update: Update) => Promise<void>;

export interface PollingOptions {
  /** Filter update types (default: ["message_created"]) */
  types?: string[];
  /** Max updates per request 1-1000 (default: 100) */
  limit?: number;
  /** Long-poll timeout in seconds 0-90 (default: 30) */
  timeout?: number;
  /** Generic handler for non-message_created updates (callbacks, edits, etc.) */
  onUpdate?: UpdateHandler;
}

// ─── Helpers ────────────────────────────────────────────────────

function log(msg: string): void {
  process.stderr.write(`[max-polling] ${new Date().toISOString()} ${msg}\n`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function isMessageCreated(u: Update): u is MessageCreatedUpdate {
  return u.update_type === "message_created";
}

// ─── Polling loop ───────────────────────────────────────────────

async function pollLoop(
  token: string,
  onMessage: MessageHandler,
  signal: AbortSignal,
  opts: PollingOptions,
  onUpdate?: UpdateHandler,
): Promise<void> {
  let marker: number | null = null;
  const types = opts.types ?? ["message_created", "bot_started", "message_callback"];
  const limit = opts.limit ?? 100;
  const timeout = opts.timeout ?? POLL_TIMEOUT_SEC;

  while (!signal.aborted) {
    try {
      // Build URL
      const url = new URL(`${API_BASE}/updates`);
      url.searchParams.set("timeout", String(timeout));
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("types", types.join(","));
      if (marker !== null) {
        url.searchParams.set("marker", String(marker));
      }

      // log(`poll: marker=${marker ?? "null"}`); // debug only

      // Fetch with abort support
      // Request timeout = long-poll timeout + 10s network grace
      const fetchTimeout = (timeout + 10) * 1000;
      const timeoutId = setTimeout(() => {
        // noop — AbortSignal.timeout would abort the parent,
        // we handle this via a per-request controller below
      }, fetchTimeout);

      const reqController = new AbortController();

      // Link parent signal to per-request controller
      const onAbort = () => reqController.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });

      // Set per-request timeout
      const reqTimeout = setTimeout(() => {
        reqController.abort(new Error("request timeout"));
      }, fetchTimeout);

      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: "GET",
          headers: {
            Authorization: token,
            Accept: "application/json",
          },
          signal: reqController.signal,
        });
      } finally {
        clearTimeout(reqTimeout);
        clearTimeout(timeoutId);
        signal.removeEventListener("abort", onAbort);
      }

      // Handle HTTP errors
      if (response.status === 429) {
        log(`Rate limited (429). Pausing ${RETRY_DELAY_RATE_LIMIT / 1000}s...`);
        await sleep(RETRY_DELAY_RATE_LIMIT, signal);
        continue;
      }

      if (response.status >= 500) {
        log(`Server error (${response.status}). Pausing ${RETRY_DELAY_SERVER_ERROR / 1000}s...`);
        await sleep(RETRY_DELAY_SERVER_ERROR, signal);
        continue;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        log(`HTTP ${response.status}: ${body.slice(0, 200)}`);
        await sleep(RETRY_DELAY_NETWORK, signal);
        continue;
      }

      // Parse response
      const data = (await response.json()) as UpdatesResponse;

      // Update marker
      if (data.marker !== null && data.marker !== undefined) {
        marker = data.marker;
      }

      // Process updates
      if (data.updates && data.updates.length > 0) {
        for (const update of data.updates) {
          if (signal.aborted) break;

          if (isMessageCreated(update)) {
            try {
              await onMessage(update);
            } catch (err) {
              log(`Handler error: ${err instanceof Error ? err.message : String(err)}`);
            }
          } else if (onUpdate) {
            try {
              await onUpdate(update);
            } catch (err) {
              log(`Update handler error: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          if (!signal.aborted) {
            await sleep(POLL_CYCLE_DELAY_MS, signal).catch(() => undefined);
          }
        }
      }
    } catch (err: unknown) {
      // Abort is expected on stop
      if (signal.aborted) break;

      const msg = err instanceof Error ? err.message : String(err);
      log(`Network error: ${msg}. Retrying in ${RETRY_DELAY_NETWORK / 1000}s...`);

      try {
        await sleep(RETRY_DELAY_NETWORK, signal);
      } catch {
        break; // aborted during sleep
      }
    }
  }

  log("Polling stopped.");
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Start long-polling for MAX bot updates.
 *
 * @param token   Bot API token (from business.max.ru)
 * @param onMessage  Callback for each message_created event
 * @param opts    Optional polling parameters
 * @returns       stop() function — call it to gracefully stop polling
 */
export function startPolling(
  token: string,
  onMessage: MessageHandler,
  opts: PollingOptions = {},
): () => void {
  const controller = new AbortController();

  // Fire and forget — errors are handled inside the loop
  pollLoop(token, onMessage, controller.signal, opts, opts.onUpdate).catch((err) => {
    if (!controller.signal.aborted) {
      log(`Fatal polling error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  log("Polling started.");

  // Return stop function
  return () => {
    if (!controller.signal.aborted) {
      log("Stop requested.");
      controller.abort(new Error("polling stopped by caller"));
    }
  };
}
