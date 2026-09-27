/**
 * Hand-off between a journaled webhook update and core's own restart recovery.
 *
 * Core records a recovery claim when it adopts an agent turn and resumes that
 * turn after a crash by itself. The journal row of the update must therefore
 * be completed at adoption, not only when the dispatch returns: replaying it
 * after a crash mid-turn would run the turn twice (SDK durable ingress rule:
 * "mark the event complete at dispatch adoption"). The queue runs each
 * journaled dispatch with its completion callback; the reply dispatch passes
 * it on as the public `turnAdoptionLifecycle` reply option. Without `admission`
 * or `ownerKey` core groups queued follow-ups exactly as without a lifecycle.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const adoption = new AsyncLocalStorage<() => Promise<void>>();

/** Run a dispatch whose agent turn, once adopted by core, calls `onAdopted`. */
export function runWithMaxTurnAdoption<T>(
  onAdopted: () => Promise<void>,
  dispatch: () => Promise<T>,
): Promise<T> {
  return adoption.run(onAdopted, dispatch);
}

/** Reply options fragment carrying the current update's adoption callback, if any. */
export function maxTurnAdoptionReplyOptions(): {
  turnAdoptionLifecycle?: { onAdopted: () => Promise<void> };
} {
  const onAdopted = adoption.getStore();
  return onAdopted ? { turnAdoptionLifecycle: { onAdopted } } : {};
}
