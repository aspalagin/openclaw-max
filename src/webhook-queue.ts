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
import type { MaxJournalEntry, MaxUpdateJournal } from './update-journal.js';

/** Updates handled at once across chats; one chat is always sequential. */
export const MAX_WEBHOOK_CHAT_CONCURRENCY = 4;
/** Accepted-but-unprocessed updates kept per account before new ones are dropped. */
export const MAX_WEBHOOK_PENDING_LIMIT = 5000;
/** How long a stopping consumer waits for in-flight dispatches (gateway stop budget is 5 s). */
export const MAX_WEBHOOK_STOP_GRACE_MS = 3000;
/** How long a restarted consumer waits for its predecessor's in-flight dispatches. */
export const MAX_WEBHOOK_HANDOVER_WAIT_MS = 60_000;

/** Default age past which updates the bot would answer are skipped (maxEventAgeMinutes). */
export const MAX_EVENT_MAX_AGE_MINUTES = 60;

/** Updates a late answer would confuse; registry updates (bot_added, …) are always handled. */
const AGE_FENCED_UPDATE_TYPES = new Set([
  'message_created',
  'message_edited',
  'message_callback',
  'bot_started',
]);

/** maxEventAgeMinutes in ms; 0 (or less) turns the age fence off. */
export function resolveMaxEventMaxAgeMs(minutes: number | undefined): number {
  const value = minutes ?? MAX_EVENT_MAX_AGE_MINUTES;
  return value > 0 ? value * 60_000 : 0;
}

/**
 * Age of an update the bot would answer, when it is past `maxAgeMs`: MAX's
 * event time, else when it was received. Undefined when fresh or not fenced.
 */
export function staleMaxUpdateAgeMs(
  update: MaxUpdate,
  maxAgeMs: number,
  now: number,
  receivedAt?: number,
): number | undefined {
  if (maxAgeMs <= 0 || !AGE_FENCED_UPDATE_TYPES.has(update.update_type)) return undefined;
  const at = typeof update.timestamp === 'number' ? update.timestamp : receivedAt;
  if (at === undefined) return undefined;
  const age = now - at;
  return age > maxAgeMs ? age : undefined;
}

/** The queue could not take an update: the route answers non-200 so MAX redelivers. */
export class MaxWebhookQueueRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaxWebhookQueueRejectedError';
  }
}

export type MaxWebhookAdmitResult = 'queued' | 'duplicate' | 'stale' | 'dropped';

/** Serialization lane: the chat an update belongs to. */
export function maxWebhookUpdateLane(update: MaxUpdate): string {
  return String(update.message?.recipient?.chat_id ?? update.chat_id ?? 'global');
}

/** An update in memory; `entry` is its journal row when the queue is durable. */
type QueuedUpdate = { update: MaxUpdate; entry?: MaxJournalEntry };

type Handover = { updates: QueuedUpdate[]; settled: Promise<void> };

/**
 * Updates acked to MAX but not dispatched when an account task stopped
 * (config reload, channel restart). MAX will not redeliver them, so the next
 * task of the same account in this process picks them up.
 */
const handovers = new Map<string, Handover>();
/** Open queues per account: a stopping task hands leftovers to an overlapping successor. */
const openQueues = new Map<string, Set<(item: QueuedUpdate) => void>>();

export type MaxWebhookUpdateQueue = {
  /**
   * Called by the route handler (request context) before it answers MAX:
   * durably records (journal) and enqueues, never dispatches. Throws
   * MaxWebhookQueueRejectedError (full, overflow "reject") or the journal
   * write error — the route then answers 503 and MAX redelivers.
   */
  admit: (update: MaxUpdate, dedupeKey?: string) => Promise<MaxWebhookAdmitResult>;
  /** In-memory enqueue (no journal); drops beyond the pending limit. */
  push: (update: MaxUpdate) => void;
  /**
   * Durable queue: take over entries an earlier process left in the journal,
   * ahead of everything queued since. Stale ones (maxAgeMs) are completed
   * without dispatch. Call before the route is registered.
   */
  recover: () => Promise<{ recovered: number; stale: number; unreadable: number }>;
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
  /** Durable mode: updates are journaled before the ack and survive restarts. */
  journal?: MaxUpdateJournal;
  /** Full queue: "reject" (default) answers MAX non-200 so it redelivers; "drop" acks and drops. */
  overflow?: 'reject' | 'drop';
  /** Skip updates the bot would answer when older than this; 0 = no limit. */
  maxAgeMs?: number;
  now?: () => number;
  onWarn?: (message: string) => void;
}): MaxWebhookUpdateQueue {
  const { accountId, journal } = params;
  const overflow = params.overflow ?? 'reject';
  const maxAgeMs = params.maxAgeMs ?? 0;
  const now = params.now ?? Date.now;
  const concurrency = Math.max(1, params.concurrency ?? MAX_WEBHOOK_CHAT_CONCURRENCY);
  const pendingLimit = params.pendingLimit ?? MAX_WEBHOOK_PENDING_LIMIT;
  const stopGraceMs = params.stopGraceMs ?? MAX_WEBHOOK_STOP_GRACE_MS;
  const handoverWaitMs = params.handoverWaitMs ?? MAX_WEBHOOK_HANDOVER_WAIT_MS;

  // Taken over at creation: updates pushed later must queue behind them.
  const previous = handovers.get(accountId);
  handovers.delete(accountId);
  const inbox: QueuedUpdate[] = previous ? [...previous.updates] : [];
  let pending = inbox.length;
  let closed = false;
  let wake: (() => void) | undefined;
  let warn: ((message: string) => void) | undefined = params.onWarn;

  const enqueue = (item: QueuedUpdate): void => {
    if (closed) {
      // Route still selected this target while the task was stopping.
      const successor = [...siblings].at(-1);
      if (successor) return successor(item);
      const handover = handovers.get(accountId);
      if (handover) handover.updates.push(item);
      else handovers.set(accountId, { updates: [item], settled: Promise.resolve() });
      return;
    }
    pending += 1;
    inbox.push(item);
    wake?.();
  };
  const siblings = openQueues.get(accountId) ?? new Set();
  siblings.add(enqueue);
  openQueues.set(accountId, siblings);

  const push = (update: MaxUpdate): void => {
    if (!closed && pending >= pendingLimit) {
      warn?.(
        `[${accountId}] MAX webhook queue full (${pendingLimit}); dropping ${update.update_type}`,
      );
      return;
    }
    enqueue({ update });
  };

  const admit: MaxWebhookUpdateQueue['admit'] = async (update, dedupeKey) => {
    const staleMs = staleMaxUpdateAgeMs(update, maxAgeMs, now());
    if (staleMs !== undefined) {
      warn?.(
        `[${accountId}] MAX webhook: ${update.update_type} from ${Math.round(staleMs / 60_000)} min ago skipped (older than maxEventAgeMinutes)`,
      );
      return 'stale';
    }
    if (journal && dedupeKey && journal.isDuplicate(dedupeKey)) return 'duplicate';
    if (!closed && pending >= pendingLimit) {
      if (overflow === 'reject') {
        throw new MaxWebhookQueueRejectedError(
          `MAX webhook queue full (${pendingLimit} pending); ${update.update_type} refused for redelivery`,
        );
      }
      warn?.(
        `[${accountId}] MAX webhook queue full (${pendingLimit}); dropping ${update.update_type}`,
      );
      return 'dropped';
    }
    const entry = journal ? await journal.append(update, dedupeKey) : undefined;
    enqueue({ update, entry });
    return 'queued';
  };

  const recover: MaxWebhookUpdateQueue['recover'] = async () => {
    if (!journal) return { recovered: 0, stale: 0, unreadable: 0 };
    const { entries, unreadable } = await journal.readPending();
    const recovered: QueuedUpdate[] = [];
    let stale = 0;
    for (const entry of entries) {
      if (staleMaxUpdateAgeMs(entry.update, maxAgeMs, now(), entry.receivedAt) !== undefined) {
        stale += 1;
        await journal.complete(entry);
        continue;
      }
      recovered.push({ update: entry.update, entry });
    }
    if (recovered.length > 0) {
      if (closed) {
        for (const item of recovered) enqueue(item);
      } else {
        // An earlier process accepted these before anything queued here.
        inbox.unshift(...recovered);
        pending += recovered.length;
        wake?.();
      }
    }
    return { recovered: recovered.length, stale, unreadable };
  };

  /** Stop accepting and pass undispatched updates (lanes first, then inbox) on. */
  const close = (fromLanes: QueuedUpdate[], settled: Promise<void>): void => {
    if (closed) return;
    closed = true;
    wake = undefined;
    siblings.delete(enqueue);
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
      for (const item of leftover) successor(item);
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
    if (onWarn) warn = onWarn;
    const lanes = new Map<string, QueuedUpdate[]>();
    const ready: string[] = [];
    const active = new Set<string>();
    const inflight = new Set<Promise<void>>();

    const route = (item: QueuedUpdate): void => {
      const lane = maxWebhookUpdateLane(item.update);
      const queued = lanes.get(lane);
      if (queued) queued.push(item);
      else lanes.set(lane, [item]);
      if (!active.has(lane) && !ready.includes(lane)) ready.push(lane);
    };

    const runLane = async (lane: string): Promise<void> => {
      try {
        for (;;) {
          if (abortSignal.aborted) return;
          const item = lanes.get(lane)?.shift();
          if (!item) return;
          pending -= 1;
          try {
            await dispatch(item.update);
          } catch (err) {
            onError(err, item.update);
          }
          // Handled or failed alike: a failed turn is not replayed (0.7 semantics).
          if (item.entry) await journal?.complete(item.entry);
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
        while (inbox.length > 0) route(inbox.shift() as QueuedUpdate);
        pump();
        await nextWake();
        wake = undefined;
      }
    } finally {
      abortSignal.removeEventListener('abort', onAbort);
      const leftover: QueuedUpdate[] = [];
      for (const queued of lanes.values()) leftover.push(...queued);
      lanes.clear();
      const settled = Promise.allSettled([...inflight]).then(() => undefined);
      close(leftover, settled);
      await waitAtMost(settled, stopGraceMs);
    }
  };

  return { admit, push, recover, consume, close: () => close([], Promise.resolve()) };
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
