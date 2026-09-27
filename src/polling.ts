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

import { MaxApiError, type MaxSubscription } from './api.js';
import { dispatchUpdate } from './dispatch.js';
import {
  MAX_SUBSCRIBED_UPDATE_TYPES,
  type MaxMonitorOptions,
  type MaxStatusPatch,
} from './monitor-types.js';

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

export async function startMaxPollingLoop(opts: MaxMonitorOptions): Promise<void> {
  const { api, account, abortSignal, log, statusSink } = opts;
  let marker: number | null = opts.state?.marker ?? null;

  log?.info(
    `[${account.accountId}] MAX long-polling started${marker != null ? ` (resuming from marker ${marker})` : ''}`,
  );

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
        try {
          await dispatchUpdate(update, opts);
        } catch (err) {
          log?.error(
            `[${account.accountId}] Error dispatching update ${update.update_type}: ${String(err)}`,
          );
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
