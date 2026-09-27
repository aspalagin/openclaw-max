/**
 * Long-polling transport: GET /updates loop with a persisted marker, and the
 * start-up cleanup of webhook subscriptions that would silence polling.
 */

import {
  channelReadyPatch,
  createTransportActivityStatusPatch,
} from 'openclaw/plugin-sdk/gateway-runtime';
import {
  type BackoffPolicy,
  computeBackoff,
  sleepWithAbort,
} from 'openclaw/plugin-sdk/runtime-env';

import { MaxApiError, type MaxSubscription, type MaxUpdate } from './api.js';
import { dispatchUpdate } from './dispatch.js';
import { isMaxGatewayDrainingError, waitForMaxDrainRetry } from './gateway-drain.js';
import {
  MAX_SUBSCRIBED_UPDATE_TYPES,
  type MaxMonitorOptions,
  type MaxStatusPatch,
} from './monitor-types.js';
import { runWithMaxTurnAdoption } from './turn-adoption.js';
import { type MaxUpdateJournal, openMaxUpdateJournal } from './update-journal.js';
import { maxUpdateDedupeKey } from './webhook.js';
import { resolveMaxEventMaxAgeMs, staleMaxUpdateAgeMs } from './webhook-queue.js';

/**
 * Polling mode: MAX stops serving GET /updates while any webhook subscription
 * exists, so a leftover subscription (another deploy, a manual test) would
 * leave the bot deaf without a single error. Remove it and say so.
 * @internal exported for testing.
 */
export async function clearMaxSubscriptionsForPolling(
  opts: Pick<MaxMonitorOptions, 'api' | 'account' | 'log'>,
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
      log?.error(
        `[${account.accountId}] MAX unsubscribe ${subscription.url} failed: ${String(err)}`,
      );
    }
  }
}

/** Pause after failed polls: 2 s doubling up to 60 s, plus up to 20% jitter; a good poll resets it. */
const POLL_BACKOFF: BackoffPolicy = { initialMs: 2_000, maxMs: 60_000, factor: 2, jitter: 0.2 };

/** A rejected token (401) does not heal in seconds: retry rarely instead of at the error pace. */
export const POLL_AUTH_PAUSE_MS = 5 * 60_000;

/** Ceiling for a server Retry-After, so one answer cannot silence the bot for hours. */
const POLL_MAX_RETRY_AFTER_MS = 10 * 60_000;

function isAuthRejected(err: unknown): boolean {
  return err instanceof MaxApiError && err.status === 401;
}

/**
 * Delay before the next poll after `failures` failed polls in a row: the
 * exponential backoff, at least the server's Retry-After (bounded), and a
 * long fixed pause for a rejected token.
 * @internal exported for testing.
 */
export function resolvePollRetryDelayMs(err: unknown, failures: number): number {
  if (isAuthRejected(err)) return POLL_AUTH_PAUSE_MS;
  const backoffMs = computeBackoff(POLL_BACKOFF, failures);
  const retryAfterMs = err instanceof MaxApiError ? err.retryAfterMs : undefined;
  if (!retryAfterMs) return backoffMs;
  return Math.max(backoffMs, Math.min(retryAfterMs, POLL_MAX_RETRY_AFTER_MS));
}

/**
 * Dedupe keys of handled updates survive restarts in the account journal: a
 * restart mid-batch re-fetches the whole batch (the marker is persisted only
 * after it), and core's inbound dedupe lives in process memory. Undefined when
 * the state directory is not writable (then replays are dispatched again).
 */
async function openPollingJournal(opts: MaxMonitorOptions): Promise<MaxUpdateJournal | undefined> {
  const { account, log } = opts;
  try {
    return await openMaxUpdateJournal({
      accountId: account.accountId,
      warn: (message) => log?.warn(`[${account.accountId}] ${message}`),
    });
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    log?.warn(
      `[${account.accountId}] MAX update journal unavailable (${typeof code === 'string' ? code : String(err)}); updates handled before a restart may be handled again`,
    );
    return undefined;
  }
}

/**
 * One polled update: skip a handled or stale one, dispatch, remember it.
 * False when the channel stopped while the draining gateway refused it: not
 * handled, not remembered.
 */
async function handlePolledUpdate(
  update: MaxUpdate,
  opts: MaxMonitorOptions,
  journal: MaxUpdateJournal | undefined,
  maxAgeMs: number,
): Promise<boolean> {
  const { account, log } = opts;
  const key = maxUpdateDedupeKey(update);
  if (key && journal?.hasCompleted(key)) {
    log?.debug?.(
      `[${account.accountId}] MAX polling: ${update.update_type} already handled, skipped`,
    );
    return true;
  }
  let remembered: Promise<void> | undefined;
  const remember = (): Promise<void> =>
    (remembered ??= key && journal ? journal.remember(key) : Promise.resolve());
  const staleMs = staleMaxUpdateAgeMs(update, maxAgeMs, Date.now());
  if (staleMs !== undefined) {
    log?.warn(
      `[${account.accountId}] MAX polling: ${update.update_type} from ${Math.round(staleMs / 60_000)} min ago skipped (older than maxEventAgeMinutes)`,
    );
  } else {
    try {
      const durable = Boolean(key && journal);
      const adopted = () => remembered !== undefined;
      if (!(await dispatchThroughDrain(remember, adopted, update, opts, durable))) return false;
    } catch (err) {
      log?.error(
        `[${account.accountId}] Error dispatching update ${update.update_type}: ${String(err)}`,
      );
    }
  }
  await remember();
  return true;
}

/**
 * Dispatch; with `durable`, `done` also runs at core's turn adoption. Core then
 * owns the turn and resumes it after a crash by itself: marking the update
 * handled only when the dispatch returns would replay it after the restart and
 * run the turn twice (see turn-adoption.ts).
 */
function dispatchWithAdoption(
  done: () => Promise<void>,
  update: MaxUpdate,
  opts: MaxMonitorOptions,
  durable: boolean,
): Promise<void> {
  const dispatch = () => dispatchUpdate(update, opts);
  return durable ? runWithMaxTurnAdoption(done, dispatch) : dispatch();
}

/**
 * dispatchWithAdoption, again after a pause while the draining gateway refuses
 * a durable update before core adopted its turn: the turn never started (see
 * gateway-drain.ts). False when the channel stopped first; other errors throw.
 */
async function dispatchThroughDrain(
  done: () => Promise<void>,
  adopted: () => boolean,
  update: MaxUpdate,
  opts: MaxMonitorOptions,
  durable: boolean,
): Promise<boolean> {
  const { account, log } = opts;
  let refusals = 0;
  for (;;) {
    try {
      await dispatchWithAdoption(done, update, opts, durable);
      if (refusals > 0) {
        log?.info(
          `[${account.accountId}] MAX polling: ${update.update_type} accepted after ${refusals} refusal(s) of the draining gateway`,
        );
      }
      return true;
    } catch (err) {
      if (!durable || adopted() || !isMaxGatewayDrainingError(err)) throw err;
      refusals += 1;
      if (refusals === 1) {
        log?.warn(
          `[${account.accountId}] MAX polling: the gateway is draining and refused ${update.update_type}; retried until accepted or the channel stops (then after the restart)`,
        );
      }
      if (!(await waitForMaxDrainRetry(refusals, opts.abortSignal))) return false;
    }
  }
}

/**
 * Updates a webhook-mode run accepted but did not handle before the transport
 * was switched to polling: handle them first, in order.
 */
async function drainWebhookLeftovers(
  opts: MaxMonitorOptions,
  journal: MaxUpdateJournal,
  maxAgeMs: number,
): Promise<void> {
  const { account, log } = opts;
  let pending;
  try {
    pending = await journal.readPending();
  } catch (err) {
    log?.error(`[${account.accountId}] MAX update journal read failed: ${String(err)}`);
    return;
  }
  if (pending.entries.length + pending.unreadable === 0) return;
  log?.warn(
    `[${account.accountId}] MAX polling: ${pending.entries.length} webhook update(s) accepted before the restart handled first, ${pending.unreadable} unreadable dropped`,
  );
  for (const entry of pending.entries) {
    if (opts.abortSignal.aborted) {
      journal.release(entry);
      continue;
    }
    let completed: Promise<void> | undefined;
    const complete = (): Promise<void> => (completed ??= journal.complete(entry));
    const staleMs = staleMaxUpdateAgeMs(entry.update, maxAgeMs, Date.now(), entry.receivedAt);
    if (staleMs === undefined) {
      try {
        const adopted = () => completed !== undefined;
        if (!(await dispatchThroughDrain(complete, adopted, entry.update, opts, true))) {
          // Stopped while the draining gateway refused it: the next start takes it.
          journal.release(entry);
          continue;
        }
      } catch (err) {
        log?.error(
          `[${account.accountId}] Error dispatching update ${entry.update.update_type}: ${String(err)}`,
        );
      }
    }
    await complete();
  }
}

export async function startMaxPollingLoop(opts: MaxMonitorOptions): Promise<void> {
  const { api, account, abortSignal, log, statusSink } = opts;
  let marker: number | null = opts.state?.marker ?? null;

  log?.info(
    `[${account.accountId}] MAX long-polling started${marker != null ? ` (resuming from marker ${marker})` : ''}`,
  );

  const maxAgeMs = resolveMaxEventMaxAgeMs(account.config.maxEventAgeMinutes);
  const journal = await openPollingJournal(opts);
  if (journal) await drainWebhookLeftovers(opts, journal, maxAgeMs);

  let failures = 0;
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
      failures = 0;

      // A completed poll is the transport proof the gateway waits for: it moves
      // the account out of lifecycle "starting", clears a stale lastError, and
      // refreshes the timestamp the health policy uses to spot a dead socket.
      statusSink?.(
        channelReadyPatch({
          ...createTransportActivityStatusPatch(),
          mode: 'polling',
        }) as MaxStatusPatch,
      );

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
        if (!(await handlePolledUpdate(update, opts, journal, maxAgeMs))) {
          batchCompleted = false;
          break;
        }
      }

      // …but only PERSIST the marker after the whole batch is handled. A restart
      // mid-batch then resumes from before the unprocessed updates (at-least-once);
      // the journal's dedupe keys skip the ones already handled.
      if (batchCompleted && !abortSignal.aborted && resp.marker != null) {
        opts.state?.setMarker(resp.marker);
      }
    } catch (err) {
      if (abortSignal.aborted) break;
      failures += 1;
      const delayMs = resolvePollRetryDelayMs(err, failures);
      const retryIn = `retrying in ${Math.round(delayMs / 1000)}s`;
      log?.error(
        isAuthRejected(err)
          ? `[${account.accountId}] MAX rejected the bot token (401): check botToken/tokenFile; ${retryIn}`
          : `[${account.accountId}] Polling error: ${String(err)}; ${retryIn}`,
      );
      // Record the error but keep `connected` untouched: this loop owns its
      // retries, and flipping to disconnected on a transient blip would hand
      // the health monitor a restart trigger. A genuinely dead transport is
      // caught by lastTransportActivityAt going stale instead.
      statusSink?.({ lastError: String(err) } as MaxStatusPatch);
      // The account stop ends the pause at once (sleepWithAbort rejects).
      await sleepWithAbort(delayMs, abortSignal).catch(() => undefined);
    }
  }

  statusSink?.({ connected: false } as MaxStatusPatch);
  log?.info(`[${account.accountId}] MAX long-polling stopped`);
}
