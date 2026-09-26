/**
 * Webhook update queue: the gateway route only enqueues, the account task
 * consumes and dispatches.
 *
 * Why the hop matters: the gateway runs every plugin HTTP handler under a
 * request-scoped root-work admission (AsyncLocalStorage) and releases it as
 * soon as the handler returns. Agent runs and session work started from that
 * async context later see a released admission and fail with
 * `GatewayDrainingError: Gateway is draining` although the gateway is healthy.
 * The account task is started outside any request root, so work it spawns is
 * admitted like the polling loop's. Every dispatch therefore has to start
 * from the consumer (`consume()`), never from `push()`.
 */

import type { MaxUpdate } from './api.js';

/** Updates handled at once across chats; one chat is always sequential. */
export const MAX_WEBHOOK_CHAT_CONCURRENCY = 4;
/** Accepted-but-unprocessed updates kept per account before new ones are dropped. */
export const MAX_WEBHOOK_PENDING_LIMIT = 5000;
/** How long a stopping consumer waits for in-flight dispatches (gateway stop budget is 5 s). */
export const MAX_WEBHOOK_STOP_GRACE_MS = 3000;
/** How long a restarted consumer waits for its predecessor's in-flight dispatches. */
export const MAX_WEBHOOK_HANDOVER_WAIT_MS = 60_000;

/** Serialization lane: the chat an update belongs to. */
export function maxWebhookUpdateLane(update: MaxUpdate): string {
  return String(update.message?.recipient?.chat_id ?? update.chat_id ?? 'global');
}

type Handover = { updates: MaxUpdate[]; settled: Promise<void> };

/**
 * Updates acked to MAX but not dispatched when an account task stopped
 * (config reload, channel restart). MAX will not redeliver them, so the next
 * task of the same account in this process picks them up.
 */
const handovers = new Map<string, Handover>();
/** Open queues per account: a stopping task hands leftovers to an overlapping successor. */
const openQueues = new Map<string, Set<(update: MaxUpdate) => void>>();

export type MaxWebhookUpdateQueue = {
  /** Called by the route handler (request context): enqueue only, never dispatch. */
  push: (update: MaxUpdate) => void;
  /**
   * Runs in the account task until abortSignal fires: dispatches updates in
   * order per chat, up to `concurrency` chats at once. Resolves after stop.
   */
  consume: (params: {
    dispatch: (update: MaxUpdate) => Promise<void>;
    abortSignal: AbortSignal;
    onError: (err: unknown, update: MaxUpdate) => void;
    onWarn?: (message: string) => void;
  }) => Promise<void>;
  /** Start failed before consume(): release the queue, keeping taken-over updates. */
  close: () => void;
};

export function createMaxWebhookUpdateQueue(params: {
  accountId: string;
  concurrency?: number;
  pendingLimit?: number;
  stopGraceMs?: number;
  handoverWaitMs?: number;
}): MaxWebhookUpdateQueue {
  const { accountId } = params;
  const concurrency = Math.max(1, params.concurrency ?? MAX_WEBHOOK_CHAT_CONCURRENCY);
  const pendingLimit = params.pendingLimit ?? MAX_WEBHOOK_PENDING_LIMIT;
  const stopGraceMs = params.stopGraceMs ?? MAX_WEBHOOK_STOP_GRACE_MS;
  const handoverWaitMs = params.handoverWaitMs ?? MAX_WEBHOOK_HANDOVER_WAIT_MS;

  // Taken over at creation: updates pushed later must queue behind them.
  const previous = handovers.get(accountId);
  handovers.delete(accountId);
  const inbox: MaxUpdate[] = previous ? [...previous.updates] : [];
  let pending = inbox.length;
  let closed = false;
  let wake: (() => void) | undefined;
  let warn: ((message: string) => void) | undefined;

  const push = (update: MaxUpdate): void => {
    if (closed) {
      // Route still selected this target while the task was stopping.
      const successor = [...siblings].at(-1);
      if (successor) return successor(update);
      const handover = handovers.get(accountId);
      if (handover) handover.updates.push(update);
      else handovers.set(accountId, { updates: [update], settled: Promise.resolve() });
      return;
    }
    if (pending >= pendingLimit) {
      warn?.(
        `[${accountId}] MAX webhook queue full (${pendingLimit}); dropping ${update.update_type}`,
      );
      return;
    }
    pending += 1;
    inbox.push(update);
    wake?.();
  };
  const siblings = openQueues.get(accountId) ?? new Set();
  siblings.add(push);
  openQueues.set(accountId, siblings);

  /** Stop accepting and pass undispatched updates (lanes first, then inbox) on. */
  const close = (fromLanes: MaxUpdate[], settled: Promise<void>): void => {
    if (closed) return;
    closed = true;
    wake = undefined;
    siblings.delete(push);
    if (siblings.size === 0 && openQueues.get(accountId) === siblings) {
      openQueues.delete(accountId);
    }
    const leftover = [...fromLanes, ...inbox];
    inbox.length = 0;
    pending = 0;
    if (leftover.length === 0) return;
    const successor = [...siblings].at(-1);
    if (successor) {
      // A newer task of this account is already consuming: queue there.
      for (const update of leftover) successor(update);
      warn?.(
        `[${accountId}] MAX webhook stopped with ${leftover.length} update(s) not dispatched; moved to the running successor`,
      );
      return;
    }
    const late = handovers.get(accountId)?.updates ?? [];
    handovers.set(accountId, { updates: [...leftover, ...late], settled });
    warn?.(
      `[${accountId}] MAX webhook stopped with ${leftover.length} update(s) not dispatched; handed over to the next start`,
    );
  };

  const consume: MaxWebhookUpdateQueue['consume'] = async ({
    dispatch,
    abortSignal,
    onError,
    onWarn,
  }) => {
    warn = onWarn;
    const lanes = new Map<string, MaxUpdate[]>();
    const ready: string[] = [];
    const active = new Set<string>();
    const inflight = new Set<Promise<void>>();

    const route = (update: MaxUpdate): void => {
      const lane = maxWebhookUpdateLane(update);
      const queued = lanes.get(lane);
      if (queued) queued.push(update);
      else lanes.set(lane, [update]);
      if (!active.has(lane) && !ready.includes(lane)) ready.push(lane);
    };

    const runLane = async (lane: string): Promise<void> => {
      try {
        for (;;) {
          if (abortSignal.aborted) return;
          const update = lanes.get(lane)?.shift();
          if (!update) return;
          pending -= 1;
          try {
            await dispatch(update);
          } catch (err) {
            onError(err, update);
          }
        }
      } finally {
        active.delete(lane);
        if (lanes.get(lane)?.length === 0) lanes.delete(lane);
        else if (lanes.has(lane) && !ready.includes(lane)) ready.push(lane);
        pump();
      }
    };

    // Called only from this consumer's async chain (loop or runLane), so every
    // dispatch inherits the account task's context.
    const pump = (): void => {
      if (abortSignal.aborted) return;
      while (active.size < concurrency && ready.length > 0) {
        const lane = ready.shift() as string;
        active.add(lane);
        const run = runLane(lane);
        inflight.add(run);
        void run.finally(() => inflight.delete(run));
      }
    };

    const nextWake = (): Promise<void> =>
      new Promise<void>((resolve) => {
        wake = resolve;
        if (inbox.length > 0 || abortSignal.aborted) resolve();
      });
    const onAbort = (): void => wake?.();
    abortSignal.addEventListener('abort', onAbort, { once: true });

    try {
      if (previous && !abortSignal.aborted) {
        // Keep per-chat order across a restart: the stopped task may still be
        // finishing an update of a chat whose next updates we now hold.
        await waitAtMost(previous.settled, handoverWaitMs, abortSignal);
      }
      while (!abortSignal.aborted) {
        while (inbox.length > 0) route(inbox.shift() as MaxUpdate);
        pump();
        await nextWake();
        wake = undefined;
      }
    } finally {
      abortSignal.removeEventListener('abort', onAbort);
      const leftover: MaxUpdate[] = [];
      for (const queued of lanes.values()) leftover.push(...queued);
      lanes.clear();
      const settled = Promise.allSettled([...inflight]).then(() => undefined);
      close(leftover, settled);
      await waitAtMost(settled, stopGraceMs);
    }
  };

  return { push, consume, close: () => close([], Promise.resolve()) };
}

/** Resolves when `promise` settles, `ms` elapse or `signal` aborts — whichever is first. */
async function waitAtMost(promise: Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref?.();
        if (signal) {
          onAbort = resolve;
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** @internal test helper: forget handed-over updates. */
export function resetMaxWebhookHandoversForTest(): void {
  handovers.clear();
  openQueues.clear();
}
