/**
 * MAX Messenger Bot API — Webhook transport
 *
 * HTTP server that receives updates from MAX platform via POST requests.
 * Alternative to long polling for production environments.
 *
 * Uses: POST /subscriptions to register webhook URL with MAX API.
 * Node 18+ built-in http + fetch. Zero external dependencies.
 */

import * as http from "node:http";
import * as crypto from "node:crypto";
import type { MessageCreatedUpdate, Update } from "./types.js";
import type { MessageHandler, UpdateHandler } from "./polling.js";

// ─── Constants ──────────────────────────────────────────────────

const API_BASE = "https://platform-api.max.ru";
const DEFAULT_PORT = 8443;
const MAX_WEBHOOK_BODY_SIZE = 10 * 1024 * 1024;

// ─── Types ──────────────────────────────────────────────────────

export interface WebhookOptions {
  /** Public URL the MAX platform will POST updates to */
  webhookUrl: string;
  /** Local port to listen on (default: 8443) */
  port?: number;
  /** Update types to subscribe to */
  types?: string[];
  /**
   * Secret token for authenticating inbound webhook requests.
   * If omitted, a random UUID is generated automatically.
   * Appended to webhookUrl as ?token=<secret> when registering with MAX API.
   */
  secret?: string;
}

// ─── Helpers ────────────────────────────────────────────────────

function log(msg: string): void {
  process.stderr.write(`[max-webhook] ${new Date().toISOString()} ${msg}\n`);
}

function isMessageCreated(u: Update): u is MessageCreatedUpdate {
  return u.update_type === "message_created";
}

// ─── Subscription management ────────────────────────────────────

/**
 * Register a webhook subscription with MAX API.
 */
async function registerSubscription(
  token: string,
  url: string,
  types: string[],
): Promise<void> {
  const response = await fetch(`${API_BASE}/subscriptions`, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ url, update_types: types }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Failed to register webhook: HTTP ${response.status} — ${body.slice(0, 300)}`);
  }

  log(`Webhook registered: ${url} for types: ${types.join(", ")}`);
}

/**
 * Remove webhook subscription.
 */
async function removeSubscription(token: string, url: string): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/subscriptions`, {
      method: "DELETE",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ url }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      log(`Failed to remove webhook subscription: HTTP ${response.status} — ${body.slice(0, 200)}`);
    } else {
      log(`Webhook subscription removed: ${url}`);
    }
  } catch (err) {
    log(`Error removing webhook: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Webhook server ─────────────────────────────────────────────

/**
 * Start a webhook HTTP server that receives MAX bot updates.
 *
 * @param token      Bot API token
 * @param onMessage  Handler for message_created updates
 * @param opts       Webhook configuration
 * @param onUpdate   Optional handler for other update types
 * @returns          stop() function — call it to gracefully stop the server
 */
export function startWebhook(
  token: string,
  onMessage: MessageHandler,
  opts: WebhookOptions,
  onUpdate?: UpdateHandler,
): () => void {
  const port = opts.port ?? DEFAULT_PORT;
  const types = opts.types ?? ["message_created", "bot_started", "message_callback"];
  const secret = opts.secret ?? crypto.randomUUID();
  let stopped = false;

  // Append secret token to webhook URL for registration
  const webhookUrlWithToken = new URL(opts.webhookUrl);
  webhookUrlWithToken.searchParams.set("token", secret);
  const registrationUrl = webhookUrlWithToken.toString();

  log(`Webhook secret token generated (first 8 chars): ${secret.slice(0, 8)}...`);

  const server = http.createServer(async (req, res) => {
    // Only accept POST requests
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }

    // Verify secret token from query string
    const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const reqToken = reqUrl.searchParams.get("token");
    if (reqToken !== secret) {
      log(`Rejected webhook request: invalid token (from ${req.socket.remoteAddress})`);
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_SIZE) {
      res.writeHead(413, { "Content-Type": "text/plain" });
      res.end("Payload Too Large");
      return;
    }

    // Read body
    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of req) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totalSize += buf.byteLength;
      if (totalSize > MAX_WEBHOOK_BODY_SIZE) {
        res.writeHead(413, { "Content-Type": "text/plain" });
        res.end("Payload Too Large");
        req.destroy();
        return;
      }
      chunks.push(buf);
    }

    try {
      const body = Buffer.concat(chunks).toString("utf-8");
      const update = JSON.parse(body) as Update;

      // Respond 200 immediately to acknowledge receipt
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");

      // Process update asynchronously
      if (isMessageCreated(update)) {
        await onMessage(update).catch((err) => {
          log(`Message handler error: ${err instanceof Error ? err.message : String(err)}`);
        });
      } else if (onUpdate) {
        await onUpdate(update).catch((err) => {
          log(`Update handler error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } catch (err) {
      log(`Webhook parse error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request");
      }
    }
  });

  // Start server and register subscription with secret token in URL
  server.listen(port, async () => {
    log(`Webhook server listening on port ${port}`);
    try {
      await registerSubscription(token, registrationUrl, types);
    } catch (err) {
      log(`Failed to register subscription: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Return stop function
  return () => {
    if (stopped) return;
    stopped = true;
    log("Webhook stop requested.");

    // Remove subscription first, then close server
    removeSubscription(token, registrationUrl).finally(() => {
      server.close(() => {
        log("Webhook server closed.");
      });
    });
  };
}
