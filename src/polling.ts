/**
 * Long-polling transport: GET /updates loop with a persisted marker, and the
 * start-up cleanup of webhook subscriptions that would silence polling.
 */

import {
  channelReadyPatch,
  createTransportActivityStatusPatch,
} from 'openclaw/plugin-sdk/gateway-runtime';

import type { MaxSubscription } from './api.js';
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

export async function startMaxPollingLoop(opts: MaxMonitorOptions): Promise<void> {
  const { api, account, abortSignal, log, statusSink } = opts;
  let marker: number | null = opts.state?.marker ?? null;

  log?.info(
    `[${account.accountId}] MAX long-polling started${marker != null ? ` (resuming from marker ${marker})` : ''}`,
  );

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
