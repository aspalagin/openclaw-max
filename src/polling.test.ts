/**
 * Tests for the long-polling retry policy: exponential backoff with jitter,
 * reset after a good poll, Retry-After, the 401 pause and stop during a pause.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MaxApiError, type MaxUpdate } from './api.js';
import { POLL_AUTH_PAUSE_MS, resolvePollRetryDelayMs, startMaxPollingLoop } from './polling.js';
import { MaxStateStore } from './state.js';
import { maxTurnAdoptionReplyOptions } from './turn-adoption.js';
import type * as UpdateJournal from './update-journal.js';
import { openMaxUpdateJournal, resetMaxUpdateJournalsForTest } from './update-journal.js';

const dispatchCalls = vi.hoisted(() => ({ fn: undefined as undefined | ((u: unknown) => void) }));
const journalMode = vi.hoisted(() => ({ unavailable: false }));
vi.mock('./update-journal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UpdateJournal>();
  return {
    ...actual,
    openMaxUpdateJournal: vi.fn(
      async (options: Parameters<typeof actual.openMaxUpdateJournal>[0]) => {
        if (journalMode.unavailable) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return actual.openMaxUpdateJournal(options);
      },
    ),
  };
});
vi.mock('./dispatch.js', () => ({
  dispatchUpdate: vi.fn(async (update: unknown) => dispatchCalls.fn?.(update)),
}));

function apiError(status: number, retryAfterMs?: number): MaxApiError {
  const err = new MaxApiError(`MAX API GET /updates → ${status}`, status, null);
  if (retryAfterMs) err.retryAfterMs = retryAfterMs;
  return err;
}

describe('resolvePollRetryDelayMs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('doubles from 2 s up to the 60 s ceiling', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const err = new Error('fetch failed');
    expect([1, 2, 3, 4, 5, 6, 12].map((n) => resolvePollRetryDelayMs(err, n))).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
    ]);
  });

  it('adds up to 20% jitter below the ceiling', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const err = new Error('fetch failed');
    expect(resolvePollRetryDelayMs(err, 1)).toBeGreaterThan(2_000);
    expect(resolvePollRetryDelayMs(err, 1)).toBeLessThanOrEqual(2_400);
    expect(resolvePollRetryDelayMs(err, 20)).toBe(60_000);
  });

  it('waits at least the server Retry-After, bounded by 10 minutes', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(resolvePollRetryDelayMs(apiError(429, 30_000), 1)).toBe(30_000);
    expect(resolvePollRetryDelayMs(apiError(429, 1_000), 3)).toBe(8_000);
    expect(resolvePollRetryDelayMs(apiError(503, 2 * 3_600_000), 1)).toBe(600_000);
  });

  it('pauses 5 minutes on a rejected token', () => {
    expect(resolvePollRetryDelayMs(apiError(401), 1)).toBe(POLL_AUTH_PAUSE_MS);
    expect(resolvePollRetryDelayMs(apiError(401), 7)).toBe(POLL_AUTH_PAUSE_MS);
  });
});

describe('startMaxPollingLoop retries', () => {
  type Step = Error | { updates: []; marker: number };

  let abort: AbortController;
  let log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  /** getUpdates plays `steps` in order, then hangs like a long poll until the stop. */
  function start(steps: Step[]) {
    const getUpdates = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      const step = steps.shift();
      if (step instanceof Error) throw step;
      if (step) return step;
      return new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    const statusSink = vi.fn();
    const done = startMaxPollingLoop({
      api: { getUpdates },
      account: { accountId: 'default', config: {} },
      abortSignal: abort.signal,
      log,
      statusSink,
    } as never);
    return { getUpdates, statusSink, done };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    abort = new AbortController();
    log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    // Keep the first poll synchronous with the fake clock: no disk I/O first.
    journalMode.unavailable = true;
  });

  afterEach(() => {
    journalMode.unavailable = false;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls without the journal when it cannot be opened, and says so', async () => {
    const { getUpdates, done } = start([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(getUpdates).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('MAX update journal unavailable (EACCES)'),
    );
    abort.abort();
    await done;
  });

  it('backs off exponentially and resets after a successful poll', async () => {
    const net = () => new Error('fetch failed');
    const { getUpdates, done } = start([net(), net(), { updates: [], marker: 5 }, net()]);

    await vi.advanceTimersByTimeAsync(0);
    expect(getUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(getUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getUpdates).toHaveBeenCalledTimes(2);
    // Second failure in a row: 4 s; then the good poll and the next one run at once.
    await vi.advanceTimersByTimeAsync(3_999);
    expect(getUpdates).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(getUpdates).toHaveBeenCalledTimes(4);
    // The failure after the good poll waits the initial 2 s again, not 8 s.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getUpdates).toHaveBeenCalledTimes(5);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('retrying in 2s'));

    abort.abort();
    await done;
  });

  it('honors Retry-After', async () => {
    const { getUpdates, done } = start([apiError(429, 30_000)]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(getUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getUpdates).toHaveBeenCalledTimes(2);
    abort.abort();
    await done;
  });

  it('retries a rejected token only every 5 minutes, with a clear error', async () => {
    const { getUpdates, statusSink, done } = start([apiError(401), apiError(401)]);
    await vi.advanceTimersByTimeAsync(POLL_AUTH_PAUSE_MS - 1);
    expect(getUpdates).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('MAX rejected the bot token (401)'),
    );
    expect(statusSink).toHaveBeenCalledWith({ lastError: expect.stringContaining('401') });
    await vi.advanceTimersByTimeAsync(1);
    expect(getUpdates).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL_AUTH_PAUSE_MS - 1);
    expect(getUpdates).toHaveBeenCalledTimes(2);
    abort.abort();
    await done;
  });

  it('stops during a pause without waiting it out', async () => {
    const { getUpdates, statusSink, done } = start([apiError(401)]);
    await vi.advanceTimersByTimeAsync(1_000);
    let stopped = false;
    void done.then(() => {
      stopped = true;
    });

    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(true);
    expect(getUpdates).toHaveBeenCalledTimes(1);
    expect(statusSink).toHaveBeenLastCalledWith({ connected: false });
  });
});

describe('polling across a restart', () => {
  const msg = (mid: string, timestamp = Date.now()): MaxUpdate =>
    ({
      update_type: 'message_created',
      timestamp,
      message: { body: { mid }, timestamp, recipient: { chat_id: 1 } },
    }) as MaxUpdate;

  /** One gateway process: polls `batches` in order, then hangs until stopped. */
  function run(accountId: string, batches: Array<{ updates: MaxUpdate[]; marker: number }>) {
    const abort = new AbortController();
    const state = new MaxStateStore(accountId);
    const getUpdates = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      const batch = batches.shift();
      if (batch) return structuredClone(batch);
      return new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const done = state.load().then(() =>
      startMaxPollingLoop({
        api: { getUpdates },
        account: { accountId, config: {} },
        abortSignal: abort.signal,
        log,
        state,
      } as never),
    );
    return { abort, getUpdates, log, state, done };
  }

  afterEach(() => {
    dispatchCalls.fn = undefined;
    resetMaxUpdateJournalsForTest();
  });

  it('neither loses nor repeats updates when stopped mid-batch', async () => {
    const dispatched: Array<string | undefined> = [];
    const batch = { updates: [msg('p1'), msg('p2'), msg('p3')], marker: 42 };

    const first = run('restart-mid-batch', [batch]);
    dispatchCalls.fn = (u) => {
      dispatched.push((u as MaxUpdate).message?.body?.mid);
      // The gateway stops while p1 is being handled.
      first.abort.abort();
    };
    await first.done;
    await first.state.flush();
    expect(dispatched).toEqual(['p1']);
    // Not persisted: the next start polls the same batch again.
    expect(first.state.marker).toBeUndefined();

    resetMaxUpdateJournalsForTest(); // new process
    dispatchCalls.fn = (u) => dispatched.push((u as MaxUpdate).message?.body?.mid);
    const second = run('restart-mid-batch', [batch]);
    await vi.waitFor(() => expect(second.getUpdates).toHaveBeenCalledTimes(2));
    second.abort.abort();
    await second.done;
    expect(dispatched).toEqual(['p1', 'p2', 'p3']);
    await second.state.flush();
    expect(second.state.marker).toBe(42);
  });

  it('does not replay an update whose turn core adopted before a crash', async () => {
    const dispatched: Array<string | undefined> = [];
    const batch = { updates: [msg('a1'), msg('a2')], marker: 9 };
    // Core adopts the turn of a1 (and now owns its crash recovery), then the
    // process dies mid-turn: the dispatch never returns.
    dispatchCalls.fn = async (u) => {
      dispatched.push((u as MaxUpdate).message?.body?.mid);
      await maxTurnAdoptionReplyOptions().turnAdoptionLifecycle?.onAdopted();
      await new Promise<never>(() => undefined);
    };
    const first = run('adopted-crash', [batch]);
    await vi.waitFor(() => expect(dispatched).toEqual(['a1']));
    await new Promise((resolve) => setTimeout(resolve, 20));
    first.abort.abort();

    resetMaxUpdateJournalsForTest(); // new process
    dispatchCalls.fn = (u) => dispatched.push((u as MaxUpdate).message?.body?.mid);
    const second = run('adopted-crash', [batch]);
    await vi.waitFor(() => expect(second.getUpdates).toHaveBeenCalledTimes(2));
    second.abort.abort();
    await second.done;
    expect(dispatched).toEqual(['a1', 'a2']);
  });

  it('does not replay a webhook leftover whose turn core adopted before a crash', async () => {
    const journal = await openMaxUpdateJournal({ accountId: 'adopted-leftover' });
    await journal.append(msg('w1'), 'kw1');
    resetMaxUpdateJournalsForTest(); // restarted with transport "polling"

    const dispatched: Array<string | undefined> = [];
    dispatchCalls.fn = async (u) => {
      dispatched.push((u as MaxUpdate).message?.body?.mid);
      await maxTurnAdoptionReplyOptions().turnAdoptionLifecycle?.onAdopted();
      await new Promise<never>(() => undefined);
    };
    const first = run('adopted-leftover', []);
    await vi.waitFor(() => expect(dispatched).toEqual(['w1']));
    await new Promise((resolve) => setTimeout(resolve, 20));
    first.abort.abort();

    resetMaxUpdateJournalsForTest(); // new process
    dispatchCalls.fn = (u) => dispatched.push((u as MaxUpdate).message?.body?.mid);
    const second = run('adopted-leftover', [{ updates: [msg('p1')], marker: 1 }]);
    await vi.waitFor(() => expect(second.getUpdates).toHaveBeenCalledTimes(2));
    second.abort.abort();
    await second.done;
    expect(dispatched).toEqual(['w1', 'p1']);
  });

  it('skips messages older than maxEventAgeMinutes but still handles registry updates', async () => {
    const dispatched: string[] = [];
    dispatchCalls.fn = (u) => dispatched.push((u as MaxUpdate).update_type);
    const old = Date.now() - 61 * 60_000;
    const added = { update_type: 'bot_added', timestamp: old, chat_id: 5 } as MaxUpdate;
    const polling = run('stale-poll', [{ updates: [msg('old', old), added], marker: 7 }]);
    await vi.waitFor(() => expect(polling.getUpdates).toHaveBeenCalledTimes(2));
    polling.abort.abort();
    await polling.done;
    expect(dispatched).toEqual(['bot_added']);
    expect(String(polling.log.warn.mock.calls.flat())).toContain('older than maxEventAgeMinutes');
  });

  it('first handles webhook updates left in the journal when switched to polling', async () => {
    const journal = await openMaxUpdateJournal({ accountId: 'switched' });
    await journal.append(msg('w1'), 'kw1');
    resetMaxUpdateJournalsForTest(); // restarted with transport "polling"

    const dispatched: Array<string | undefined> = [];
    dispatchCalls.fn = (u) => dispatched.push((u as MaxUpdate).message?.body?.mid);
    const polling = run('switched', [{ updates: [msg('p1')], marker: 1 }]);
    await vi.waitFor(() => expect(polling.getUpdates).toHaveBeenCalledTimes(2));
    polling.abort.abort();
    await polling.done;
    expect(dispatched).toEqual(['w1', 'p1']);
  });
});
