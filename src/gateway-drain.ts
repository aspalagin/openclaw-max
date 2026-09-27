/**
 * Core's refusal of new turns while the gateway drains for a stop or restart.
 *
 * During a graceful stop core keeps the channels running (up to its drain
 * budget, minutes) but refuses to start new work with `GatewayDrainingError`.
 * Refused before core adopted the turn, the update was never handled: the
 * webhook queue and the polling loop keep it and retry after a pause until the
 * channel stops; its journal row then stays on disk for the next process. The
 * plugin SDK exports nothing for this error, so it is recognized by name.
 */

import { sleepWithAbort } from 'openclaw/plugin-sdk/runtime-env';

const DRAINING_ERROR_NAME = 'GatewayDrainingError';
/** Causes followed below the error itself. */
const MAX_CAUSE_DEPTH = 5;
/** Pauses between retries of a refused update: 2 s, 5 s, 10 s, then every 30 s. */
const DRAIN_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000];

/** True when `err` or one of its causes (up to 5 deep) is core's drain refusal. */
export function isMaxGatewayDrainingError(err: unknown): boolean {
  let current = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ((current as { name?: unknown }).name === DRAINING_ERROR_NAME) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Pause before the retry after the `refusals`-th refusal in a row (1-based). */
export function maxDrainRetryDelayMs(refusals: number): number {
  const index = Math.min(Math.max(refusals, 1), DRAIN_RETRY_DELAYS_MS.length) - 1;
  return DRAIN_RETRY_DELAYS_MS[index] as number;
}

/** Waits out the pause after a refusal; false when the channel stopped meanwhile (at once). */
export async function waitForMaxDrainRetry(
  refusals: number,
  abortSignal: AbortSignal,
): Promise<boolean> {
  if (abortSignal.aborted) return false;
  await sleepWithAbort(maxDrainRetryDelayMs(refusals), abortSignal).catch(() => undefined);
  return !abortSignal.aborted;
}
