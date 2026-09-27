/**
 * MAX webhook transport — HTTP ingress on the gateway server and the
 * subscription lifecycle (GET/POST/DELETE /subscriptions).
 *
 * The route is registered dynamically from the account lifecycle through
 * `registerPluginHttpRoute` (plugin-sdk/webhook-ingress): it lives exactly as
 * long as the account task, carries plugin-managed auth (the MAX shared
 * secret), and a failed registration fails the account start instead of
 * reporting ready without live ingress.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import {
  normalizeWebhookPath,
  readJsonWebhookBodyOrReject,
  registerPluginHttpRoute,
  resolveWebhookPath,
} from 'openclaw/plugin-sdk/webhook-ingress';

import type { ResolvedMaxAccount } from './accounts.js';
import type { MaxUpdate } from './api.js';
import type { MaxApi } from './api.js';

/** Plugin id from openclaw.plugin.json — the owner of the gateway route. */
export const MAX_PLUGIN_ID = 'openclaw-max';
/** Stable same-plugin route sub-owner (see gateway-routes docs). */
export const MAX_WEBHOOK_ROUTE_SOURCE = 'max-webhook';
export const DEFAULT_MAX_WEBHOOK_PATH = '/max/webhook';

/** Header MAX sends with the subscription secret. */
const SECRET_HEADER = 'x-max-bot-api-secret';
const DEDUPE_CAPACITY = 1000;

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
  /**
   * Awaited before MAX gets its 200: must only record/enqueue (never dispatch).
   * A rejection answers 503 so MAX redelivers the update.
   */
  onUpdate: (update: MaxUpdate) => Promise<void>;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

type RegisteredTarget = MaxWebhookTarget & { seen: Map<string, true> };

const webhookTargets = new Map<string, RegisteredTarget[]>();

export function resolveMaxWebhookPath(webhookPath?: string, webhookUrl?: string): string {
  return (
    resolveWebhookPath({ webhookPath, webhookUrl, defaultPath: DEFAULT_MAX_WEBHOOK_PATH }) ??
    DEFAULT_MAX_WEBHOOK_PATH
  );
}

export function registerMaxWebhookTarget(target: MaxWebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget: RegisteredTarget = { ...target, path: key, seen: new Map() };
  webhookTargets.set(key, [...(webhookTargets.get(key) ?? []), normalizedTarget]);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) {
      webhookTargets.set(key, updated);
    } else {
      webhookTargets.delete(key);
    }
  };
}

export type RegisterMaxWebhookRoute = typeof registerPluginHttpRoute;

/**
 * Register the gateway HTTP route for a webhook path. Canonically equal paths
 * of several accounts share one route: the handler picks the target by secret.
 */
export function registerMaxWebhookRoute(params: {
  path: string;
  accountId: string;
  log?: (message: string) => void;
  register?: RegisterMaxWebhookRoute;
}): () => void {
  const register = params.register ?? registerPluginHttpRoute;
  return register({
    path: normalizeWebhookPath(params.path),
    auth: 'plugin',
    match: 'exact',
    pluginId: MAX_PLUGIN_ID,
    source: MAX_WEBHOOK_ROUTE_SOURCE,
    accountId: params.accountId,
    replaceExisting: true,
    throwOnFailure: true,
    log: params.log,
    handler: handleMaxWebhookRequest,
  });
}

/**
 * Key for redelivery dedupe: MAX retries a delivery that was not acknowledged
 * with 200 in time, so the same update can arrive twice.
 * @internal exported for testing.
 */
export function maxUpdateDedupeKey(update: MaxUpdate): string | undefined {
  const id =
    update.callback?.callback_id ??
    update.message?.body?.mid ??
    // A forward-only message has no body; its link carries the original mid.
    update.message?.link?.message?.mid ??
    (typeof update.message_id === 'string' ? update.message_id : undefined);
  if (!id && update.timestamp == null) return undefined;
  return `${update.update_type}:${update.timestamp ?? ''}:${id ?? ''}`;
}

/** Returns true when the key was already seen (LRU bounded by DEDUPE_CAPACITY). */
function rememberUpdate(seen: Map<string, true>, key: string): boolean {
  if (seen.has(key)) {
    seen.delete(key);
    seen.set(key, true);
    return true;
  }
  seen.set(key, true);
  if (seen.size > DEDUPE_CAPACITY) {
    const oldest = seen.keys().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return false;
}

export async function handleMaxWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = normalizeWebhookPath(url.pathname);
  const targets = webhookTargets.get(path);

  if (!targets || targets.length === 0) {
    return false;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end('Method Not Allowed');
    return true;
  }

  // Authenticate before reading the body. Targets without a secret never
  // match: an unauthenticated webhook would let anyone inject updates.
  const rawSecret = req.headers[SECRET_HEADER];
  const providedSecret = Array.isArray(rawSecret) ? (rawSecret[0] ?? '') : (rawSecret ?? '');
  const matchedTarget = providedSecret
    ? targets.find((target) => target.secret && secretsMatch(target.secret, providedSecret))
    : undefined;

  if (!matchedTarget) {
    res.statusCode = 401;
    res.end('Unauthorized');
    return true;
  }

  // Size/timeout/closed-connection/malformed-JSON failures are answered by the
  // SDK helper (413/408/400) — it has already written the response.
  const body = await readJsonWebhookBodyOrReject({
    req,
    res,
    maxBytes: 1024 * 1024,
    timeoutMs: 30_000,
    emptyObjectOnEmpty: false,
    invalidJsonMessage: 'invalid payload',
  });
  if (!body.ok) {
    return true;
  }

  const raw = body.value;
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    typeof (raw as { update_type?: unknown }).update_type !== 'string'
  ) {
    res.statusCode = 400;
    res.end('invalid payload');
    return true;
  }

  const update = raw as MaxUpdate;

  const dedupeKey = maxUpdateDedupeKey(update);
  if (dedupeKey && rememberUpdate(matchedTarget.seen, dedupeKey)) {
    matchedTarget.log?.(
      `[${matchedTarget.account.accountId}] MAX webhook: duplicate ${dedupeKey} skipped`,
    );
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // MAX needs 200 within 30 s while an agent turn can take minutes: onUpdate
  // only records the update (durable journal) and enqueues it for the account
  // task, then MAX gets its 200. It must not dispatch: this request's work
  // admission is released when the handler returns, so agent/session work
  // started from here would fail with GatewayDrainingError. When the update
  // could not be recorded, 503 makes MAX redeliver it instead of losing it.
  try {
    await matchedTarget.onUpdate(update);
  } catch (err) {
    if (dedupeKey) matchedTarget.seen.delete(dedupeKey);
    matchedTarget.error?.(
      `[${matchedTarget.account.accountId}] MAX webhook: ${update.update_type} not queued, answering 503 for redelivery: ${String(err)}`,
    );
    res.statusCode = 503;
    res.end('Service Unavailable');
    return true;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
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
      'message_created',
      'message_callback',
      'message_edited',
      'message_removed',
      'bot_started',
      'bot_stopped',
      'bot_added',
      'bot_removed',
      'dialog_cleared',
      'dialog_removed',
      'chat_title_changed',
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
