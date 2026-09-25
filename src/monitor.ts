/**
 * MAX monitor — receives updates (long polling or webhook) and dispatches them
 * to OpenClaw.
 *
 * Uses the same inbound pipeline as other channel plugins:
 * finalizeInboundContext → dispatchReplyWithBufferedBlockDispatcher
 */

import { randomBytes } from "node:crypto";

import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { ChannelAccountSnapshot, ChannelLogSink } from "openclaw/plugin-sdk/channel-contract";
import { type ChannelInboundMediaInput, toInboundMediaFacts } from "openclaw/plugin-sdk/channel-inbound";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { channelReadyPatch, createTransportActivityStatusPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";

import { type MaxAccountConfig, readSecretFile, type ResolvedMaxAccount } from "./accounts.js";
import type { MaxApi} from "./api.js";
import { type MaxAttachment, type MaxCallback, type MaxMessage, type MaxSubscription,type MaxUpdate, type MaxUpdateType, type MaxUser } from "./api.js";
import { sanitizeMaxFileName } from "./media-temp.js";
import {
  decodeMaxPresentationCallback,
  materializeMaxPresentation,
  type MaxPresentationCallback,
  readMaxDeliveryPin,
} from "./presentation.js";
import { getMaxRuntime } from "./runtime.js";
import { answerMaxCallback, editMaxMessage, pinMaxMessage, readMaxChannelButtons, readMaxChannelSendOptions,sendMaxMediaGroup, sendMaxMessage } from "./send.js";
import { MaxStateStore } from "./state.js";
import { rememberStickerCode } from "./sticker-cache.js";
import type { MaxMarkupElement } from "./types.js";
import {
  type MaxWebhookTarget,
  type RegisterMaxWebhookRoute,
  registerMaxWebhookRoute,
  registerMaxWebhookTarget,
  resolveMaxWebhookPath,
  subscribeMaxWebhook,
} from "./webhook.js";

/**
 * Runtime status patches published to the gateway. Activity timestamps are not
 * enough: the gateway leaves an account in `lifecycle: "starting"` until the
 * transport reports `connected`, and its health policy can only detect a dead
 * socket from `lastTransportActivityAt`.
 */
export type MaxStatusPatch = Partial<ChannelAccountSnapshot>;

export interface MaxMonitorOptions {
  api: MaxApi;
  account: ResolvedMaxAccount;
  config: OpenClawConfig;
  abortSignal: AbortSignal;
  botUserId?: number;
  botUsername?: string;
  log?: ChannelLogSink;
  statusSink?: (patch: MaxStatusPatch) => void;
  /** Persistent marker + chat registry (created by startMaxPolling when absent) */
  state?: MaxStateStore;
  /** Gateway route registration; defaults to plugin-sdk registerPluginHttpRoute (tests inject a mock) */
  registerWebhookRoute?: RegisterMaxWebhookRoute;
}

/**
 * Update types this channel consumes. Shared by long polling (types filter)
 * and webhook subscriptions (update_types).
 */
export const MAX_SUBSCRIBED_UPDATE_TYPES: MaxUpdateType[] = [
  "message_created",
  "message_callback",
  "message_edited",
  "message_removed",
  "bot_started",
  "bot_stopped",
  "bot_added",
  "bot_removed",
  "dialog_cleared",
  "dialog_removed",
  "chat_title_changed",
];

export type MaxTransport = "polling" | "webhook";

/** Explicit `transport` wins; otherwise a configured webhookUrl selects webhook mode. */
export function resolveMaxTransport(config: MaxAccountConfig): MaxTransport {
  if (config.transport === "polling" || config.transport === "webhook") return config.transport;
  return config.webhookUrl?.trim() ? "webhook" : "polling";
}

export async function startMaxPolling(opts: MaxMonitorOptions): Promise<void> {
  const { account, log } = opts;

  // Persistent state: polling marker + chat registry + webhook secret
  if (!opts.state) {
    opts.state = new MaxStateStore(account.accountId, (err) => {
      log?.error(`[${account.accountId}] MAX state persist failed: ${String(err)}`);
    });
  }
  try {
    await opts.state.load();
  } catch (err) {
    log?.error(`[${account.accountId}] MAX state load failed: ${String(err)}`);
  }

  if (resolveMaxTransport(account.config) === "webhook") {
    await startMaxWebhook(opts);
  } else {
    // An active subscription silently disables long polling on the MAX side.
    await clearMaxSubscriptionsForPolling(opts);
    await startMaxPollingLoop(opts);
  }
}

/**
 * Polling mode: MAX stops serving GET /updates while any webhook subscription
 * exists, so a leftover subscription (another deploy, a manual test) would
 * leave the bot deaf without a single error. Remove it and say so.
 * @internal exported for testing.
 */
export async function clearMaxSubscriptionsForPolling(
  opts: Pick<MaxMonitorOptions, "api" | "account" | "log">,
): Promise<void> {
  const { api, account, log } = opts;
  let subscriptions: MaxSubscription[];
  try {
    subscriptions = (await api.getSubscriptions()).subscriptions ?? [];
  } catch (err) {
    log?.warn(`[${account.accountId}] MAX subscriptions check failed: ${String(err)}`);
    return;
  }
  for (const subscription of subscriptions) {
    log?.warn(
      `[${account.accountId}] MAX webhook subscription ${subscription.url} is active — long polling gets no updates while it exists; removing it`,
    );
    try {
      await api.unsubscribe(subscription.url);
    } catch (err) {
      log?.error(`[${account.accountId}] MAX unsubscribe ${subscription.url} failed: ${String(err)}`);
    }
  }
}

async function startMaxPollingLoop(opts: MaxMonitorOptions): Promise<void> {
  const { api, account, abortSignal, log, statusSink } = opts;
  let marker: number | null = opts.state?.marker ?? null;

  log?.info(`[${account.accountId}] MAX long-polling started${marker != null ? ` (resuming from marker ${marker})` : ""}`);

  while (!abortSignal.aborted) {
    try {
      // The channel abort signal must reach the request: a 35s long poll that
      // only the request's own timeout can cancel outlives the gateway's 5s
      // stop budget and logs "channel stop exceeded 5000ms after abort".
      const resp = await api.getUpdates({
        timeout: 30,
        marker: marker ?? undefined,
        types: MAX_SUBSCRIBED_UPDATE_TYPES,
        signal: abortSignal,
      });

      // A completed poll is the transport proof the gateway waits for: it moves
      // the account out of lifecycle "starting", clears a stale lastError, and
      // refreshes the timestamp the health policy uses to spot a dead socket.
      statusSink?.(channelReadyPatch({
        ...createTransportActivityStatusPatch(),
        mode: "polling",
      }) as MaxStatusPatch);

      // Advance the in-memory marker so the next poll in this process moves on…
      if (resp.marker != null) {
        marker = resp.marker;
      }

      let batchCompleted = true;
      for (const update of resp.updates) {
        if (abortSignal.aborted) {
          batchCompleted = false;
          break;
        }
        try {
          await dispatchUpdate(update, opts);
        } catch (err) {
          log?.error(`[${account.accountId}] Error dispatching update ${update.update_type}: ${String(err)}`);
        }
      }

      // …but only PERSIST the marker after the whole batch is handled. A restart
      // mid-batch then resumes from before the unprocessed updates (at-least-once);
      // OpenClaw dedups replays by mid, so re-delivery is safe but loss is not.
      if (batchCompleted && !abortSignal.aborted && resp.marker != null) {
        opts.state?.setMarker(resp.marker);
      }
    } catch (err) {
      if (abortSignal.aborted) break;
      log?.error(`[${account.accountId}] Polling error: ${String(err)}`);
      // Record the error but keep `connected` untouched: this loop owns its
      // retries, and flipping to disconnected on a transient blip would hand
      // the health monitor a restart trigger. A genuinely dead transport is
      // caught by lastTransportActivityAt going stale instead.
      statusSink?.({ lastError: String(err) } as MaxStatusPatch);
      // Back off on error
      await sleep(3000);
    }
  }

  statusSink?.({ connected: false } as MaxStatusPatch);
  log?.info(`[${account.accountId}] MAX long-polling stopped`);
}

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

async function startMaxWebhook(opts: MaxMonitorOptions): Promise<void> {
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

// ── Dispatch ──

/** mark_seen vanished from current MAX docs; keep behind config (default on). */
function shouldMarkSeen(account: ResolvedMaxAccount): boolean {
  return account.config.markSeen !== false;
}

function sendReadReceipt(chatId: number | undefined, opts: MaxMonitorOptions): void {
  const { log, account } = opts;
  if (!chatId) return;
  if (shouldMarkSeen(account)) {
    opts.api.sendAction(chatId, "mark_seen").catch((err) => {
      log?.debug?.(`[${account.accountId}] mark_seen failed: ${String(err)}`);
    });
  }
  // typing_on is sent once, by processIncomingMessage right before the agent
  // run — only for messages that pass the group/DM gates.
}

/** @internal - Exported for testing only */
export async function dispatchUpdate(
  update: MaxUpdate,
  opts: MaxMonitorOptions,
): Promise<void> {
  const { log, account, statusSink } = opts;

  switch (update.update_type) {
    case "message_created": {
      if (!update.message) break;
      // Skip messages from the bot itself
      if (opts.botUserId && update.message.sender?.user_id === opts.botUserId) break;
      statusSink?.({ lastInboundAt: Date.now() });
      // Mark message as read (typing starts once the message reaches the agent)
      sendReadReceipt(update.message.recipient?.chat_id, opts);
      // Passive chat discovery: GET /chats is deprecated, register group chats
      // the bot actually sees so directory.listGroups keeps working.
      const recipient = update.message.recipient;
      if (
        opts.state &&
        recipient?.chat_id != null &&
        (recipient.chat_type === "chat" || recipient.chat_type === "channel") &&
        !opts.state.hasActiveChat(recipient.chat_id)
      ) {
        // A message from this chat proves the bot is a member — (re)register it,
        // clearing any stale removedAt from an earlier bot_removed/dialog_removed.
        opts.state.upsertChat(recipient.chat_id, { type: recipient.chat_type, addedAt: Date.now() });
      }
      await processIncomingMessage(update.message, update.user_locale, opts);
      break;
    }

    case "message_callback": {
      if (!update.callback) break;
      statusSink?.({ lastInboundAt: Date.now() });
      await processCallback(update.callback, update.message ?? null, update.user_locale, opts);
      break;
    }

    case "message_edited": {
      if (!update.message) break;
      // Skip edits from the bot itself
      if (opts.botUserId && update.message.sender?.user_id === opts.botUserId) break;
      log?.debug?.(`[${account.accountId}] Message edited: ${update.message?.body?.mid} text="${update.message?.body?.text ?? "<null>"}" hasBody=${!!update.message?.body}`);
      statusSink?.({ lastInboundAt: Date.now() });
      // Mark as read (typing starts once the message reaches the agent)
      sendReadReceipt(update.message.recipient?.chat_id, opts);
      // Process edited message through the same pipeline as new messages.
      // Use a unique mid suffix to avoid OpenClaw dedup (same mid = skipped).
      const editedMessage = { ...update.message };
      const originalMid = editedMessage.body.mid;
      editedMessage.body = {
        ...editedMessage.body,
        mid: `${originalMid}_edited_${update.timestamp}`,
      };

      // MAX message_edited may not include text — fetch it from API if missing
      if (!editedMessage.body.text?.trim() && originalMid) {
        try {
          const chatId = editedMessage.recipient?.chat_id;
          if (chatId) {
            const fetched = await opts.api.getMessages(chatId, { message_ids: [originalMid], count: 1 });
            const fetchedMsg = fetched.messages?.[0];
            if (fetchedMsg?.body?.text) {
              editedMessage.body = { ...editedMessage.body, text: fetchedMsg.body.text };
              if (fetchedMsg.body.attachments?.length) {
                editedMessage.body.attachments = fetchedMsg.body.attachments;
              }
              log?.debug?.(`[${account.accountId}] Fetched edited text: "${fetchedMsg.body.text.slice(0, 50)}"`);
            }
          }
        } catch (err) {
          log?.debug?.(`[${account.accountId}] Failed to fetch edited message text: ${String(err)}`);
        }
      }

      await processIncomingMessage(editedMessage, update.user_locale, opts);
      break;
    }

    case "bot_started": {
      if (!update.user) break;
      log?.info(`[${account.accountId}] Bot started by user ${update.user.user_id}${update.payload ? " (with deeplink payload)" : ""}`);
      statusSink?.({ lastInboundAt: Date.now() });
      if (opts.state && update.chat_id != null) {
        opts.state.upsertChat(update.chat_id, { type: "dialog", addedAt: Date.now(), stopped: false });
      }
      await processBotStarted(update.user, update.chat_id, update.payload ?? undefined, opts);
      break;
    }

    case "bot_stopped": {
      // User halted the bot in a dialog — stop proactive sends until they return
      log?.info(`[${account.accountId}] Bot stopped by user ${update.user?.user_id ?? "?"} (chat ${update.chat_id ?? "?"})`);
      if (opts.state && update.chat_id != null) {
        opts.state.upsertChat(update.chat_id, { type: "dialog", stopped: true });
      }
      break;
    }

    case "bot_added": {
      log?.info(`[${account.accountId}] Bot added to chat ${update.chat_id}`);
      if (opts.state && update.chat_id != null) {
        opts.state.upsertChat(update.chat_id, {
          type: update.is_channel ? "channel" : "chat",
          addedAt: Date.now(),
        });
      }
      break;
    }

    case "bot_removed": {
      log?.info(`[${account.accountId}] Bot removed from chat ${update.chat_id}`);
      if (opts.state && update.chat_id != null) {
        opts.state.upsertChat(update.chat_id, { removedAt: Date.now() });
      }
      break;
    }

    case "dialog_removed": {
      log?.info(`[${account.accountId}] Dialog removed by user ${update.user_id ?? update.user?.user_id ?? "?"} (chat ${update.chat_id ?? "?"})`);
      if (opts.state && update.chat_id != null) {
        opts.state.upsertChat(update.chat_id, { removedAt: Date.now() });
      }
      break;
    }

    case "dialog_cleared": {
      // User wiped the dialog history on their side; keep our session but log it
      log?.info(`[${account.accountId}] Dialog cleared by user ${update.user_id ?? update.user?.user_id ?? "?"} (chat ${update.chat_id ?? "?"})`);
      break;
    }

    case "chat_title_changed": {
      if (opts.state && update.chat_id != null && typeof update.title === "string") {
        opts.state.upsertChat(update.chat_id, { title: update.title });
      }
      break;
    }

    case "message_removed": {
      // Deliberate no-op: OpenClaw sessions have no per-message retraction.
      log?.debug?.(`[${account.accountId}] Message removed in chat ${update.chat_id ?? "?"}: ${(update as { message_id?: string }).message_id ?? "?"}`);
      break;
    }

    default:
      log?.debug?.(`[${account.accountId}] Unhandled update type: ${update.update_type}`);
  }
}

// ── Process messages through OpenClaw pipeline ──

/**
 * Process incoming MAX message through OpenClaw pipeline.
 * @internal - Exported for testing only
 */
export async function processIncomingMessage(
  message: MaxMessage,
  userLocale: string | null | undefined,
  opts: MaxMonitorOptions,
): Promise<void> {
  const { account, config, log, statusSink } = opts;
  const core = getMaxRuntime();

  const senderId = message.sender?.user_id;
  const senderName = formatSenderName(message.sender);
  const senderUsername = message.sender?.username ?? undefined;

  // Determine chat type and IDs
  const chatId = message.recipient.chat_id;
  const chatType = message.recipient.chat_type; // "dialog", "chat", "channel"
  const isGroup = chatType === "chat" || chatType === "channel";

  const rawText = message.body.text ?? "";
  const messageId = message.body.mid;
  const isCallbackCommand = (message as MaxMessage & { __maxCallback?: boolean }).__maxCallback === true;
  const attachments = message.body.attachments ?? [];

  log?.debug?.(`[${account.accountId}] Processing message: mid=${messageId} chatId=${message.recipient.chat_id} chatType=${message.recipient.chat_type} senderId=${message.sender?.user_id} text="${rawText.slice(0, 50)}" attachments=${attachments.length}`);

  // Process attachments: download media, build descriptions for non-downloadable types
  const attachmentDescriptions: string[] = [];
  // One entry per downloaded attachment; array position is attachment identity.
  const mediaInputs: ChannelInboundMediaInput[] = [];

  for (const att of attachments) {
    const attType = att.type ?? "unknown";
    const payload = att.payload as Record<string, unknown> | undefined;

    // Media types with downloadable URL: image, sticker, video, audio, file
    if (["image", "sticker", "video", "audio", "file"].includes(attType)) {
      // For stickers, always capture the code for outbound use
      const stickerCode = attType === "sticker" ? ((payload?.code ?? "") as string) : "";
      if (stickerCode) {
        log?.debug?.(`[${account.accountId}] Sticker received: code=${stickerCode}`);
        attachmentDescriptions.push(`[Sticker: code=${stickerCode}]`);
        if (chatId != null) {
          rememberStickerCode(chatId, stickerCode);
        }
      }

      let url = (payload?.url ?? (att as Record<string, unknown>).url ?? "") as string;

      // Inbound video attachments often carry only a token — resolve playback
      // URLs via GET /videos/{videoToken} instead of degrading to "[video]".
      if (!url && attType === "video" && typeof payload?.token === "string" && payload.token) {
        try {
          const info = await opts.api.getVideoInfo(payload.token);
          const urls = info?.urls ?? undefined;
          url = urls?.mp4_720 ?? urls?.mp4_480 ?? urls?.mp4_1080 ?? urls?.mp4_360 ?? urls?.mp4_240 ?? urls?.mp4_144 ?? "";
          if (!url) {
            log?.debug?.(`[${account.accountId}] Video ${payload.token.slice(0, 12)}… has no playback URLs yet`);
          }
        } catch (err) {
          log?.debug?.(`[${account.accountId}] getVideoInfo failed: ${String(err)}`);
        }
      }

      // MAX may transcribe voice messages itself (AudioAttachment.transcription,
      // a sibling of payload). The text goes to the agent and the audio fact is
      // marked transcribed, so core media understanding does not run STT again.
      const transcription = attType === "audio" ? readAudioTranscription(att) : undefined;
      if (transcription) {
        attachmentDescriptions.push(`[Voice transcript: ${transcription}]`);
      }

      if (url && typeof url === "string" && url.startsWith("http")) {
        try {
          const maxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
          const fetched = await core.channel.media.fetchRemoteMedia({ url, maxBytes });
          const inboundFileName = fetched.fileName ? sanitizeMaxFileName(fetched.fileName, fetched.contentType) : undefined;
          const saved = await core.channel.media.saveMediaBuffer(
            Buffer.from(fetched.buffer),
            fetched.contentType,
            "inbound",
            maxBytes,
            inboundFileName,
          );
          // Only the local copy goes to the agent: MAX download URLs are signed
          // and short-lived, so they are not recorded as the media url.
          mediaInputs.push({
            path: saved.path,
            contentType: saved.contentType,
            fileName: inboundFileName,
            messageId,
            ...(transcription ? { transcribed: true } : {}),
          });
        } catch (err) {
          log?.error?.(`[${account.accountId}] Failed to download ${attType}: ${String(err)}`);
          // Fall back to text description (sticker code already added above)
          if (attType !== "sticker") {
            attachmentDescriptions.push(`[${attType}: ${url}]`);
          }
        }
      } else {
        // No URL — text description
        if (attType === "sticker") {
          const code = payload?.code ?? "";
          attachmentDescriptions.push(`[Sticker${code ? `: ${code}` : ""}]`);
        } else if (attType === "file") {
          const filename = (att as Record<string, unknown>).filename ?? payload?.filename ?? "";
          attachmentDescriptions.push(`[File${filename ? `: ${filename}` : ""}]`);
        } else {
          attachmentDescriptions.push(`[${attType}]`);
        }
      }
    } else if (attType === "share") {
      const url = (payload?.url ?? (att as Record<string, unknown>).url ?? "") as string;
      attachmentDescriptions.push(`[Share${url ? `: ${url}` : ""}]`);
    } else if (attType === "location") {
      const lat = (att as Record<string, unknown>).latitude ?? payload?.latitude ?? "";
      const lon = (att as Record<string, unknown>).longitude ?? payload?.longitude ?? "";
      attachmentDescriptions.push(`[Location: ${lat}, ${lon}]`);
    } else if (attType === "contact") {
      const name = payload?.name ?? payload?.vcf_info ?? "";
      attachmentDescriptions.push(`[Contact${name ? `: ${name}` : ""}]`);
    } else if (attType !== "inline_keyboard") {
      attachmentDescriptions.push(`[${attType}]`);
    }
  }

  const attachmentText = attachmentDescriptions.join(" ");
  const hasMedia = mediaInputs.length > 0;
  const effectiveText = rawText.trim() || attachmentText;

  // Skip truly empty messages (no text, no media, no meaningful attachments)
  if (!effectiveText && !hasMedia) return;

  // Check for reply context
  const replyToId = message.link?.type === "reply" ? message.link.message?.body?.mid : undefined;

  // Check for bot mention in group chats
  let wasMentioned: boolean | undefined;
  if (isGroup && (opts.botUsername || opts.botUserId)) {
    // body.markup marks mentions as user_mention elements; the @botname regex
    // stays as a fallback for clients/messages that send no markup.
    wasMentioned = isBotMentionedInMarkup(message.body?.markup, opts.botUserId, opts.botUsername);
    if (!wasMentioned && opts.botUsername) {
      const mentionPattern = new RegExp(`@${escapeRegExp(opts.botUsername)}\\b`, "i");
      wasMentioned = mentionPattern.test(rawText);
    }

    // Reply to bot's message also counts as mention (like Telegram behavior)
    if (!wasMentioned && message.link?.type === "reply") {
      const replySender = message.link.sender;
      if (replySender?.is_bot && replySender?.user_id === opts.botUserId) {
        wasMentioned = true;
        log?.debug?.(`[${account.accountId}] Reply to bot message treated as mention`);
      }
    }
  }

  // Pressing a button on the bot's own keyboard is addressed to the bot, like a
  // reply to its message — don't drop it at the group mention gate.
  if (isGroup && isCallbackCommand) {
    wasMentioned = true;
  }

  // DM security: check pairing/allowlist
  if (!isGroup) {
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    if (dmPolicy === "disabled") {
      log?.debug?.(`[${account.accountId}] Blocked DM from ${senderId} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== "open") {
      const configAllowFrom = (account.config.allowFrom ?? []).map(String);
      const storeAllowFrom = await core.channel.pairing.readAllowFromStore({ channel: "max", accountId: account.accountId }).catch(() => []);
      const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];

      const senderStr = String(senderId);
      const allowed = effectiveAllowFrom.includes(senderStr) || effectiveAllowFrom.includes("*");

      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "max",
            id: senderStr,
            accountId: account.accountId,
            meta: { name: senderName },
          });
          if (created) {
            log?.info(`[${account.accountId}] Pairing request from ${senderStr}`);
            try {
              const pairingReply = core.channel.pairing.buildPairingReply({
                channel: "max",
                idLine: `Your MAX user id: ${senderStr}`,
                code,
              });
              await sendMaxMessage(String(chatId ?? senderId), pairingReply, {
                token: account.token,
              });
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              log?.error(`[${account.accountId}] Pairing reply failed: ${String(err)}`);
            }
          }
        }
        return;
      }
    }
  }

  // Group policy
  if (isGroup) {
    const defaultGroupPolicy = config.channels?.defaults?.groupPolicy;
    const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";

    if (groupPolicy === "disabled") {
      log?.debug?.(`[${account.accountId}] Blocked group message (groupPolicy=disabled)`);
      return;
    }

    // For allowlist policy, check if chat is in the groups config
    if (groupPolicy === "allowlist") {
      const groups = account.config.groups ?? {};
      const chatIdStr = String(chatId);
      const hasWildcard = "*" in groups;
      const chatAllowed = chatIdStr in groups || hasWildcard;
      if (!chatAllowed) {
        log?.debug?.(`[${account.accountId}] Blocked group message (not in allowlist, chat=${chatIdStr})`);
        return;
      }
    }

    // Require mention in groups
    const groupCfg = account.config.groups?.[String(chatId)] ?? account.config.groups?.["*"];
    const requireMention = groupCfg?.requireMention ?? true;
    if (requireMention && !wasMentioned) {
      log?.debug?.(`[${account.accountId}] Skipping group message (not mentioned)`);
      return;
    }
  }

  // Resolve agent route
  // chatIdStr stays the delivery address (MAX addresses replies by chat_id).
  const chatIdStr = String(chatId ?? senderId);
  // DM routing keys off the sender's user_id, not the dialog's chat_id: in MAX
  // the two differ, and bindings/allowFrom are expressed in user_id terms, so a
  // chat_id peer never matches. Groups keep chat_id — it is the group's own id.
  const routePeerId = isGroup ? chatIdStr : String(senderId ?? chatId);
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "max",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: routePeerId,
    },
  });

  // Build context
  const fromLabel = isGroup
    ? `chat:${chatIdStr}`
    : senderName || `user:${senderId}`;

  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // Combine text and attachment descriptions for the agent
  const bodyForAgent = attachmentText
    ? rawText.trim()
      ? `${rawText.trim()}\n${attachmentText}`
      : attachmentText
    : rawText;

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "MAX",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: bodyForAgent,
  });

  // Detect text-slash commands (user types /status, /models, /reasoning etc.)
  const rawTextTrimmed = (rawText || "").trim();
  const isTextSlashCommand = rawTextTrimmed.startsWith("/");

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: bodyForAgent,
    RawBody: rawText,
    CommandBody: rawText || attachmentText,
    From: `max:${senderId}`,
    To: `max:${chatIdStr}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId != null ? String(senderId) : undefined,
    SenderUsername: senderUsername,
    WasMentioned: isGroup ? wasMentioned : undefined,
    Provider: "max",
    Surface: "max",
    MessageSid: messageId,
    MessageSidFull: messageId,
    ReplyToId: replyToId,
    ReplyToIdFull: replyToId,
    OriginatingChannel: "max",
    OriginatingTo: `max:${chatIdStr}`,
    // Media attachments (downloaded to local paths) as ordered media facts
    media: hasMedia ? toInboundMediaFacts(mediaInputs) : undefined,
    // Text-slash command detection: treat /status, /models etc. as text commands
    // so OpenClaw routes them through handleCommands instead of silently dropping
    ...(isTextSlashCommand ? {
      CommandSource: "text" as const,
      CommandTurn: {
        kind: "text-slash" as const,
        source: "text" as const,
        authorized: undefined, // let allowFrom resolve authorization
        body: rawTextTrimmed,
      },
    } : {}),
  });

  // Record session meta
  void core.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      log?.error(`[${account.accountId}] Failed updating session meta: ${String(err)}`);
    });

  // Dispatch through the standard reply pipeline
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "max",
    accountId: route.accountId,
  });

  // Send typing indicator while agent processes
  if (chatId != null) {
    opts.api.sendAction(chatId, "typing_on").catch((err) => {
      log?.debug?.(`[${account.accountId}] typing_on failed: ${String(err)}`);
    });
  }

  // Streaming modes: "partial" = edit single message, "block" = each block as separate message
  const streamMode = account.config.streamMode ?? "off";
  const useEditStreaming = streamMode === "partial";
  const useBlockStreaming = streamMode === "block";
  const replyMid = isCallbackCommand ? undefined : messageId.replace(/_edited_\d+$/, "");
  const callbackId = isCallbackCommand ? messageId : undefined;

  // Draft stream for edit-streaming (like Telegram's partial reply approach)
  let draftMid: string | null = null;
  let draftLastText = "";
  let draftLastEditAt = 0;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let draftStopped = false;
  const DRAFT_THROTTLE_MS = 1200;
  const DRAFT_MAX_CHARS = 4000;
  const DRAFT_MIN_CHARS = 30; // Don't send until we have enough text

  const draftUpdate = async (text: string) => {
    if (draftStopped || !text) return;
    const trimmed = text.trimEnd();
    if (!trimmed || trimmed === draftLastText) return;
    if (trimmed.length > DRAFT_MAX_CHARS) {
      draftStopped = true;
      return;
    }
    if (!draftMid && trimmed.length < DRAFT_MIN_CHARS) return; // wait for more text

    // Clear pending timer
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }

    const now = Date.now();
    const elapsed = now - draftLastEditAt;
    if (elapsed < DRAFT_THROTTLE_MS) {
      // Schedule a deferred update
      draftTimer = setTimeout(() => { draftUpdate(text); }, DRAFT_THROTTLE_MS - elapsed);
      return;
    }

    draftLastText = trimmed;
    draftLastEditAt = now;

    try {
      if (!draftMid) {
        // First chunk — send new message
        const res = await sendMaxMessage(chatIdStr, trimmed, {
          token: account.token,
          replyToMessageId: replyMid,
          format: "markdown",
        });
        draftMid = res.messageId || null;
        statusSink?.({ lastOutboundAt: Date.now() });
      } else {
        // Edit existing message
        await editMaxMessage(draftMid, trimmed, {
          token: account.token,
          format: "markdown",
        });
      }
    } catch (err) {
      draftStopped = true;
      log?.debug?.(`[${account.accountId}] MAX draft stream failed: ${String(err)}`);
    }
  };

  const draftClear = async () => {
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
    draftStopped = true;
  };

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (rawPayload) => {
        // This funnel consumes ReplyPayload directly, so it must apply the same
        // presentation fallback/render policy as core's outbound path.
        const payload = await materializeMaxPresentation(rawPayload);
        if (useEditStreaming && draftMid && payload.text) {
          // Final delivery replaces the draft message with final text. The
          // keyboard (presentation buttons) goes onto the same edit, otherwise
          // the final answer would lose its buttons.
          const finalText = payload.text;
          const buttons = readMaxChannelButtons(payload.channelData);
          if (finalText !== draftLastText || buttons?.length) {
            try {
              await editMaxMessage(draftMid, finalText, {
                token: account.token,
                format: "markdown",
                buttons,
              });
              draftLastText = finalText;
            } catch { /* best effort */ }
          }
          draftStopped = true;

          // Handle media if present (buttons already sit on the draft)
          if (payload.mediaUrls?.length || payload.mediaUrl) {
            await deliverMaxReply({
              payload: { ...payload, text: undefined, channelData: withoutMaxButtons(payload.channelData) },
              account,
              chatId: chatIdStr,
              replyToId: replyMid,
              callbackId,
              config,
              log,
              statusSink,
            });
          }
          return;
        }

        // Non-streaming path or no draft yet
        await deliverMaxReply({
          payload,
          account,
          chatId: chatIdStr,
          replyToId: replyMid,
          callbackId,
          config,
          log,
          statusSink,
        });
      },
      onError: (err, info) => {
        log?.error(`[${account.accountId}] MAX ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
      ...(useEditStreaming ? {
        onPartialReply: (payload: { text?: string }) => {
          if (payload.text) draftUpdate(payload.text);
        },
      } : {}),
      ...(useBlockStreaming ? { disableBlockStreaming: false } : {}),
    },
  });

  // Cleanup draft stream
  await draftClear();
}

/**
 * Synthesize a regular message from a button press. The keyboard's message is
 * a sibling of `callback` in the update; its recipient is the real chat
 * (dialog chat_id ≠ user_id). Only when that message is gone (null) do we fall
 * back to addressing the pressing user.
 * callback_id is not a valid MAX message id, so replies to callback-originated
 * commands must not use it as replyToMessageId.
 * @internal - Exported for testing only
 */
export function buildCallbackMessage(
  callback: MaxCallback,
  message: MaxMessage | null,
  text: string = callback.payload ?? "",
): MaxMessage & { __maxCallback: true } {
  return {
    __maxCallback: true,
    sender: callback.user,
    recipient: message ? message.recipient : { chat_id: callback.user.user_id },
    timestamp: callback.timestamp,
    body: {
      mid: callback.callback_id,
      text,
    },
  };
}

async function processCallback(
  callback: MaxCallback,
  message: MaxMessage | null,
  userLocale: string | null | undefined,
  opts: MaxMonitorOptions,
): Promise<void> {
  const payload = callback.payload ?? "";
  if (!payload.trim()) return;

  // Presentation buttons carry private envelopes (see presentation.ts).
  // Command buttons carry the command text itself and take the default path;
  // plain channelData.max.buttons payloads keep arriving as message text.
  const presentationCallback = decodeMaxPresentationCallback(payload);
  if (presentationCallback?.kind === "approval" || presentationCallback?.kind === "question") {
    await resolveMaxRuntimeControlCallback(presentationCallback, callback, opts);
    return;
  }
  // Opaque callback data goes to the agent labelled, never as a slash command.
  const text = presentationCallback?.kind === "callback"
    ? `callback_data: ${presentationCallback.value}`
    : payload;

  await processIncomingMessage(buildCallbackMessage(callback, message, text), userLocale, opts);
}

/**
 * Approvals and ask_user answers are operator actions: only senders listed
 * explicitly in the account's allowFrom may press them (a wildcard is enough
 * for questions, never for approvals).
 */
function isMaxRuntimeControlSender(account: ResolvedMaxAccount, senderId: string, kind: "approval" | "question"): boolean {
  const allowFrom = (account.config.allowFrom ?? []).map((entry) => String(entry).trim().replace(/^max:/i, ""));
  if (allowFrom.includes(senderId)) return true;
  return kind === "question" && allowFrom.includes("*");
}

async function resolveMaxRuntimeControlCallback(
  action: Extract<MaxPresentationCallback, { kind: "approval" | "question" }>,
  callback: MaxCallback,
  opts: MaxMonitorOptions,
): Promise<void> {
  const { account, config, log } = opts;
  const senderId = String(callback.user.user_id);
  let notification: string;

  if (!isMaxRuntimeControlSender(account, senderId, action.kind)) {
    log?.warn(`[${account.accountId}] MAX ${action.kind} button pressed by unauthorized sender ${senderId}`);
    notification = "You are not allowed to answer this.";
  } else {
    try {
      if (action.kind === "approval") {
        const result = await resolveApprovalOverGateway({
          cfg: config,
          approvalId: action.approvalId,
          approvalKind: action.approvalKind,
          decision: action.decision,
          channel: "max",
          accountId: account.accountId,
          senderId,
        });
        notification = result.applied ? `Decision recorded: ${action.decision}.` : "This approval was already resolved.";
      } else {
        const result = await questionGatewayRuntime.resolveOption({
          cfg: config,
          questionId: action.questionId,
          optionValue: action.optionValue,
          senderId,
          authorize: () => isMaxRuntimeControlSender(account, senderId, "question"),
        });
        notification = result.status === "answered"
          ? "Answer recorded."
          : result.status === "denied"
            ? "You are not allowed to answer this."
            : "This question is no longer open.";
      }
    } catch (err) {
      log?.error(`[${account.accountId}] MAX ${action.kind} callback failed: ${String(err)}`);
      notification = "Could not apply this action.";
    }
  }

  try {
    await opts.api.answerCallback(callback.callback_id, { notification });
  } catch (err) {
    log?.debug?.(`[${account.accountId}] MAX callback answer failed: ${String(err)}`);
  }
}

async function processBotStarted(
  user: MaxUser,
  chatId: number | undefined,
  payload: string | undefined,
  opts: MaxMonitorOptions,
): Promise<void> {
  // Synthesize a /start message; deeplink payload (max.ru/<bot>?start=...) is
  // forwarded as the command argument like other messengers do.
  const startText = payload?.trim() ? `/start ${payload.trim()}` : "/start";
  const syntheticMessage: MaxMessage = {
    sender: user,
    recipient: { chat_id: chatId ?? user.user_id, chat_type: "dialog" },
    timestamp: Date.now(),
    body: {
      mid: `bot_started_${user.user_id}_${Date.now()}`,
      text: startText,
    },
  };

  await processIncomingMessage(syntheticMessage, null, opts);
}

// ── Deliver reply ──

async function deliverMaxReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string; replyToId?: string; channelData?: unknown; delivery?: unknown };
  account: ResolvedMaxAccount;
  chatId: string;
  replyToId?: string;
  callbackId?: string;
  config: OpenClawConfig;
  log?: ChannelLogSink;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, account, chatId, config, log, statusSink } = params;
  const core = getMaxRuntime();
  const buttons = readMaxChannelButtons(payload.channelData);
  const sendOptions = readMaxChannelSendOptions(payload.channelData);

  if (params.callbackId && (payload.text || buttons?.length)) {
    try {
      await answerMaxCallback(params.callbackId, payload.text ?? "", {
        token: account.token,
        format: "markdown",
        buttons,
      });
      statusSink?.({ lastOutboundAt: Date.now() });
    } catch (err: unknown) {
      const body = (err as { body?: unknown })?.body;
      log?.error(`[${account.accountId}] MAX callback answer failed: ${String(err)}${body ? ` body=${JSON.stringify(body)}` : ""}`);
    }
    return;
  }

  // delivery.pin: pin the first delivered message (first chunk).
  let firstMessageId: string | undefined;
  const noteDelivered = (messageId: string) => {
    if (!firstMessageId && messageId) firstMessageId = messageId;
  };

  if (payload.text) {
    const chunkLimit = 4000; // MAX message limit
    const chunkMode = core.channel.text.resolveChunkMode(config, "max", account.accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(payload.text, chunkLimit, chunkMode);

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      try {
        const sent = await sendMaxMessage(chatId, chunk, {
          token: account.token,
          replyToMessageId: params.replyToId,
          format: "markdown",
          buttons: index === chunks.length - 1 ? buttons : undefined,
          ...sendOptions,
        });
        noteDelivered(sent.messageId);
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err: unknown) {
        const body = (err as { body?: unknown })?.body;
        log?.error(`[${account.accountId}] MAX send failed: ${String(err)}${body ? ` body=${JSON.stringify(body)}` : ""}`);
      }
    }
  } else if (buttons?.length) {
    try {
      const sent = await sendMaxMessage(chatId, "", {
        token: account.token,
        replyToMessageId: params.replyToId,
        format: "markdown",
        buttons,
        ...sendOptions,
      });
      noteDelivered(sent.messageId);
      statusSink?.({ lastOutboundAt: Date.now() });
    } catch (err: unknown) {
      const body = (err as { body?: unknown })?.body;
      log?.error(`[${account.accountId}] MAX send failed: ${String(err)}${body ? ` body=${JSON.stringify(body)}` : ""}`);
    }
  }

  // Media URLs — upload and send
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  // Images/videos go as albums (up to 12 per message); https image links are
  // sent by URL, other remote media is downloaded and uploaded.
  if (mediaList.length) {
    const sent = await sendMaxMediaGroup(chatId, "", mediaList, {
      token: account.token,
      replyToMessageId: params.replyToId,
      mediaMaxBytes: (account.config.mediaMaxMb ?? 20) * 1024 * 1024,
      ...sendOptions,
      onError: (err, failed) => log?.error(`[${account.accountId}] MAX media send failed (${failed.length} item(s)): ${String(err)}`),
    });
    for (const id of sent.messageIds) noteDelivered(id);
    if (sent.messageIds.length) statusSink?.({ lastOutboundAt: Date.now() });
  }

  const pin = readMaxDeliveryPin(payload.delivery);
  if (pin && firstMessageId) {
    try {
      await pinMaxMessage(chatId, firstMessageId, { token: account.token, pinNotify: pin.notify === true });
    } catch (err) {
      // Optional pins degrade; the delivered message stays.
      log?.[pin.required ? "error" : "warn"](`[${account.accountId}] MAX pin of ${firstMessageId} failed: ${String(err)}`);
    }
  }
}

// ── Helpers ──

/** MAX webhook secret: 5–256 chars of [A-Za-z0-9-]. */
function generateWebhookSecret(): string {
  return randomBytes(24).toString("base64url").replace(/_/g, "-");
}

/**
 * Whether body.markup has a user_mention of this bot: by user_id (users
 * without a username) or by user_link `@username` (case-insensitive).
 * @internal exported for testing.
 */
export function isBotMentionedInMarkup(
  markup: MaxMarkupElement[] | null | undefined,
  botUserId?: number,
  botUsername?: string,
): boolean {
  if (!Array.isArray(markup)) return false;
  const username = botUsername?.replace(/^@/, "").toLowerCase();
  return markup.some((element) => {
    if (element?.type !== "user_mention") return false;
    if (botUserId != null && element.user_id === botUserId) return true;
    const link = typeof element.user_link === "string" ? element.user_link.replace(/^@/, "").toLowerCase() : "";
    return Boolean(username && link === username);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** channelData with `max.buttons` removed (other max options kept). */
function withoutMaxButtons(channelData: unknown): unknown {
  if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) return channelData;
  const maxData = (channelData as Record<string, unknown>).max;
  if (!maxData || typeof maxData !== "object" || Array.isArray(maxData)) return channelData;
  const rest = { ...(maxData as Record<string, unknown>) };
  delete rest.buttons;
  return { ...(channelData as Record<string, unknown>), max: rest };
}

/** Non-empty MAX transcription of an audio attachment, if any. */
function readAudioTranscription(att: MaxAttachment): string | undefined {
  const value = att.transcription;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function formatSenderName(user?: MaxUser | null): string {
  if (!user) return "Unknown";
  const parts = [user.first_name];
  if (user.last_name) parts.push(user.last_name);
  return parts.join(" ") || user.username || `user_${user.user_id}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
