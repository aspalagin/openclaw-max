/**
 * MAX webhook handler — HTTP endpoint for receiving webhook updates
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { readJsonBodyWithLimit } from "openclaw/plugin-sdk/infra-runtime";
import { requestBodyErrorToText } from "openclaw/plugin-sdk/webhook-ingress";
import type { MaxUpdate } from "./api.js";
import type { ResolvedMaxAccount } from "./accounts.js";
import { MaxApi } from "./api.js";

function secretsMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type MaxWebhookTarget = {
  account: ResolvedMaxAccount;
  config: OpenClawConfig;
  path: string;
  secret?: string;
  onUpdate: (update: MaxUpdate) => Promise<void>;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

const webhookTargets = new Map<string, MaxWebhookTarget[]>();

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

export function resolveMaxWebhookPath(webhookPath?: string, webhookUrl?: string): string {
  const trimmedPath = webhookPath?.trim();
  if (trimmedPath) {
    return normalizeWebhookPath(trimmedPath);
  }
  if (webhookUrl?.trim()) {
    try {
      const parsed = new URL(webhookUrl);
      return normalizeWebhookPath(parsed.pathname || "/");
    } catch {
      return "/max";
    }
  }
  return "/max";
}

export function registerMaxWebhookTarget(target: MaxWebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  const next = [...existing, normalizedTarget];
  webhookTargets.set(key, next);
  
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) {
      webhookTargets.set(key, updated);
    } else {
      webhookTargets.delete(key);
    }
  };
}

export async function handleMaxWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = normalizeWebhookPath(url.pathname);
  const targets = webhookTargets.get(path);
  
  if (!targets || targets.length === 0) {
    return false;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  // Verify webhook secret
  const webhookSecret = String(req.headers["x-max-bot-api-secret"] ?? "");
  
  const body = await readJsonBodyWithLimit(req, {
    maxBytes: 1024 * 1024,
    timeoutMs: 30_000,
    emptyObjectOnEmpty: false,
  });
  
  if (!body.ok) {
    res.statusCode =
      body.code === "PAYLOAD_TOO_LARGE" ? 413 : body.code === "REQUEST_BODY_TIMEOUT" ? 408 : 400;
    res.end(
      body.code === "REQUEST_BODY_TIMEOUT"
        ? requestBodyErrorToText("REQUEST_BODY_TIMEOUT")
        : body.error,
    );
    return true;
  }

  const raw = body.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    res.statusCode = 400;
    res.end("invalid payload");
    return true;
  }

  const update = raw as MaxUpdate;

  // Find matching target by secret. Targets without a secret never match:
  // an unauthenticated webhook would let anyone inject updates (the monitor
  // auto-generates a secret when none is configured).
  let matchedTarget: MaxWebhookTarget | undefined;
  for (const target of targets) {
    if (target.secret && webhookSecret && secretsMatch(target.secret, webhookSecret)) {
      matchedTarget = target;
      break;
    }
  }

  if (!matchedTarget) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return true;
  }

  // Process update
  try {
    await matchedTarget.onUpdate(update);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    matchedTarget.error?.(`Webhook update processing failed: ${String(err)}`);
    res.statusCode = 500;
    res.end("Internal Server Error");
  }

  return true;
}

/**
 * Subscribe to MAX webhook
 */
export async function subscribeMaxWebhook(params: {
  api: MaxApi;
  webhookUrl: string;
  secret?: string;
  updateTypes?: string[];
}): Promise<void> {
  const { api, webhookUrl, secret, updateTypes } = params;
  
  await api.subscribe({
    url: webhookUrl,
    update_types: updateTypes ?? [
      "message_created",
      "message_callback",
      "message_edited",
      "message_removed",
      "message_chat_created",
      "bot_started",
      "bot_stopped",
      "bot_added",
      "bot_removed",
      "dialog_cleared",
      "dialog_removed",
      "chat_title_changed",
    ],
    secret,
  });
}

/**
 * Unsubscribe from MAX webhook
 */
export async function unsubscribeMaxWebhook(params: {
  api: MaxApi;
  webhookUrl: string;
}): Promise<void> {
  const { api, webhookUrl } = params;
  await api.unsubscribe(webhookUrl);
}
