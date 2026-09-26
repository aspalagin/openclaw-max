/**
 * Webhook transport: secret resolution, MAX subscription lifecycle (sync on
 * start, periodic re-check), the gateway route/target registration and the
 * ack-first per-chat serialized update queue.
 */

import { randomBytes } from "node:crypto";

import type { ChannelLogSink } from "openclaw/plugin-sdk/channel-contract";
import { channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";

import { readSecretFile, type ResolvedMaxAccount } from "./accounts.js";
import type { MaxApi, MaxSubscription, MaxUpdate } from "./api.js";
import { dispatchUpdate } from "./dispatch.js";
import { MAX_SUBSCRIBED_UPDATE_TYPES, type MaxMonitorOptions, type MaxStatusPatch } from "./monitor-types.js";
import type { MaxStateStore } from "./state.js";
import {
  type MaxWebhookTarget,
  registerMaxWebhookRoute,
  registerMaxWebhookTarget,
  resolveMaxWebhookPath,
  subscribeMaxWebhook,
} from "./webhook.js";

/**
 * Build a webhook onUpdate handler that acks immediately (returns a resolved
 * promise) and processes updates through per-chat serialized queues: ordering
 * is preserved within a chat, but a slow agent run in chat A never blocks
 * chat B (no cross-chat head-of-line blocking). Queued work checks abort so a
 * stopped monitor stops draining stale updates with its old config.
 * @internal exported for testing.
 */
export function createSerializedWebhookHandler(params: {
  dispatch: (update: MaxUpdate) => Promise<void>;
  abortSignal: AbortSignal;
  onError: (err: unknown) => void;
}): (update: MaxUpdate) => Promise<void> {
  const { dispatch, abortSignal, onError } = params;
  const chatQueues = new Map<string, Promise<void>>();

  return (update: MaxUpdate) => {
    const key = String(update.message?.recipient?.chat_id ?? update.chat_id ?? "global");
    const next = (chatQueues.get(key) ?? Promise.resolve()).then(async () => {
      if (abortSignal.aborted) return;
      try {
        await dispatch(update);
      } catch (err) {
        onError(err);
      }
    });
    chatQueues.set(key, next);
    void next.finally(() => {
      if (chatQueues.get(key) === next) chatQueues.delete(key);
    });
    return Promise.resolve();
  };
}

/** MAX secret format (SubscriptionRequestBody.secret): 5–256 of [A-Za-z0-9_-]. */
const MAX_WEBHOOK_SECRET_PATTERN = /^[\w-]{5,256}$/;

/**
 * Webhook secret: `webhookSecret`, else `webhookSecretFile`, else one generated
 * once and kept in the account state file so restarts re-subscribe with the
 * same value (a fresh secret per start would reject MAX retries of updates
 * sent before the restart).
 * @internal exported for testing.
 */
export async function resolveMaxWebhookSecret(
  account: ResolvedMaxAccount,
  state?: MaxStateStore,
): Promise<string> {
  const validate = (secret: string, source: string): string => {
    if (!MAX_WEBHOOK_SECRET_PATTERN.test(secret)) {
      throw new Error(`MAX ${source} must be 5–256 characters of A-Z, a-z, 0-9, _ and -`);
    }
    return secret;
  };

  const configured = account.config.webhookSecret?.trim();
  if (configured) return validate(configured, "webhookSecret");

  const secretFile = account.config.webhookSecretFile?.trim();
  if (secretFile) {
    const fromFile = readSecretFile(secretFile);
    if (!fromFile) throw new Error(`MAX webhookSecretFile ${secretFile} is missing, empty or not a regular file`);
    return validate(fromFile, "webhookSecretFile");
  }

  const stored = state?.webhookSecret;
  if (stored && MAX_WEBHOOK_SECRET_PATTERN.test(stored)) return stored;

  const generated = generateWebhookSecret();
  if (state) {
    state.setWebhookSecret(generated);
    await state.flush();
  }
  return generated;
}

/**
 * Make the MAX side point at exactly one URL: drop this bot's subscriptions to
 * other URLs, then (re)subscribe ours. POST is repeated on every start so the
 * secret and update_types always match the running config.
 * @internal exported for testing.
 */
export async function syncMaxWebhookSubscription(params: {
  api: MaxApi;
  accountId: string;
  webhookUrl: string;
  secret: string;
  log?: ChannelLogSink;
}): Promise<void> {
  const { api, accountId, webhookUrl, secret, log } = params;
  let existing: MaxSubscription[] = [];
  try {
    existing = (await api.getSubscriptions()).subscriptions ?? [];
  } catch (err) {
    log?.warn(`[${accountId}] MAX subscriptions check failed, subscribing anyway: ${String(err)}`);
  }
  for (const subscription of existing) {
    if (subscription.url === webhookUrl) continue;
    log?.warn(`[${accountId}] MAX webhook: removing subscription to another URL ${subscription.url}`);
    await api.unsubscribe(subscription.url);
  }
  await subscribeMaxWebhook({
    api,
    webhookUrl,
    secret,
    updateTypes: MAX_SUBSCRIBED_UPDATE_TYPES,
  });
}

/** How often webhook mode re-checks that MAX still holds our subscription. */
export const MAX_SUBSCRIPTION_CHECK_INTERVAL_MS = 12 * 60 * 1000;

/**
 * MAX drops a subscription after 8 hours of failed deliveries (tunnel or
 * gateway outage), and then nothing arrives until the next restart. Re-check
 * periodically and re-subscribe when our URL is gone. Network/API errors on
 * the check are only logged; the next tick tries again.
 * Returns a stop function; the timer is also cleared when abortSignal fires.
 * @internal exported for testing.
 */
export function startMaxSubscriptionWatch(params: {
  api: MaxApi;
  accountId: string;
  webhookUrl: string;
  secret: string;
  abortSignal: AbortSignal;
  log?: ChannelLogSink;
  intervalMs?: number;
}): () => void {
  const { api, accountId, webhookUrl, secret, abortSignal, log } = params;
  let running = false;

  const check = async (): Promise<void> => {
    if (running || abortSignal.aborted) return;
    running = true;
    try {
      let subscriptions: MaxSubscription[];
      try {
        subscriptions = (await api.getSubscriptions()).subscriptions ?? [];
      } catch (err) {
        log?.warn(`[${accountId}] MAX subscription check failed: ${String(err)}`);
        return;
      }
      if (abortSignal.aborted || subscriptions.some((s) => s.url === webhookUrl)) return;
      log?.warn(`[${accountId}] MAX webhook subscription to ${webhookUrl} is gone (MAX unsubscribes after 8 h of failed deliveries); re-subscribing`);
      try {
        await subscribeMaxWebhook({ api, webhookUrl, secret, updateTypes: MAX_SUBSCRIBED_UPDATE_TYPES });
        log?.info(`[${accountId}] MAX webhook re-subscribed: ${webhookUrl}`);
      } catch (err) {
        log?.error(`[${accountId}] MAX webhook re-subscribe failed: ${String(err)}`);
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void check(), params.intervalMs ?? MAX_SUBSCRIPTION_CHECK_INTERVAL_MS);
  timer.unref?.();
  const stop = (): void => {
    clearInterval(timer);
    abortSignal.removeEventListener("abort", stop);
  };
  abortSignal.addEventListener("abort", stop, { once: true });
  return stop;
}

export async function startMaxWebhook(opts: MaxMonitorOptions): Promise<void> {
  const { api, account, config, abortSignal, log, statusSink } = opts;

  const webhookUrl = account.config.webhookUrl?.trim();
  if (!webhookUrl) {
    throw new Error(`MAX transport "webhook" requires webhookUrl (account ${account.accountId})`);
  }
  if (!webhookUrl.startsWith("https://")) {
    log?.warn(`[${account.accountId}] MAX accepts only HTTPS webhook URLs on port 443; got ${webhookUrl}`);
  }

  const webhookPath = resolveMaxWebhookPath(account.config.webhookPath, webhookUrl);
  const webhookSecret = await resolveMaxWebhookSecret(account, opts.state);

  log?.info(`[${account.accountId}] MAX webhook mode: ${webhookUrl} (path: ${webhookPath})`);

  // Like Telegram webhook mode: no transport-activity timestamp, so the health
  // policy never flags a quiet (but healthy) webhook as a stale socket.
  statusSink?.({
    mode: "webhook",
    connected: false,
    lastConnectedAt: null,
    lastEventAt: null,
    lastTransportActivityAt: null,
  } as MaxStatusPatch);

  // MAX requires HTTP 200 within 30s while agent runs regularly take minutes.
  // The handler acks first; updates go through per-chat serialized queues.
  const enqueue = createSerializedWebhookHandler({
    dispatch: (update) => dispatchUpdate(update, opts),
    abortSignal,
    onError: (err) => log?.error(`[${account.accountId}] Webhook update dispatch failed: ${String(err)}`),
  });
  const onUpdate = (update: MaxUpdate): Promise<void> => {
    const at = Date.now();
    statusSink?.(channelReadyPatch({ lastConnectedAt: at, lastEventAt: at, mode: "webhook" }) as MaxStatusPatch);
    return enqueue(update);
  };

  const target: MaxWebhookTarget = {
    account,
    config,
    path: webhookPath,
    secret: webhookSecret,
    onUpdate,
    log: (msg) => log?.debug?.(msg),
    error: (msg) => log?.error(msg),
  };

  const unregisterTarget = registerMaxWebhookTarget(target);
  let unregisterRoute: () => void = () => {};
  try {
    // Route first: MAX may deliver the moment the subscription exists.
    unregisterRoute = registerMaxWebhookRoute({
      path: webhookPath,
      accountId: account.accountId,
      log: (msg) => log?.warn(`[${account.accountId}] ${msg}`),
      register: opts.registerWebhookRoute,
    });
    await syncMaxWebhookSubscription({
      api,
      accountId: account.accountId,
      webhookUrl,
      secret: webhookSecret,
      log,
    });
    log?.info(`[${account.accountId}] MAX webhook subscribed: ${webhookUrl}`);
  } catch (err) {
    log?.error(`[${account.accountId}] MAX webhook start failed: ${String(err)}`);
    unregisterRoute();
    unregisterTarget();
    statusSink?.({ mode: "webhook", connected: false, lastError: String(err) } as MaxStatusPatch);
    throw err;
  }

  statusSink?.(channelReadyPatch({ mode: "webhook" }) as MaxStatusPatch);

  const stopSubscriptionWatch = startMaxSubscriptionWatch({
    api,
    accountId: account.accountId,
    webhookUrl,
    secret: webhookSecret,
    abortSignal,
    log,
  });

  await waitForAbort(abortSignal);
  stopSubscriptionWatch();

  // The subscription is kept on purpose: a restart or config reload must not
  // lose updates, and MAX retries undelivered ones while the route is back.
  // To leave webhook mode, switch transport to "polling" (the polling start
  // removes it) or call DELETE /subscriptions?url=… by hand.
  unregisterRoute();
  unregisterTarget();
  statusSink?.({ mode: "webhook", connected: false } as MaxStatusPatch);
  log?.info(`[${account.accountId}] MAX webhook mode stopped (subscription kept)`);
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/** MAX webhook secret: 5–256 chars of [A-Za-z0-9-]. */
function generateWebhookSecret(): string {
  return randomBytes(24).toString("base64url").replace(/_/g, "-");
}
