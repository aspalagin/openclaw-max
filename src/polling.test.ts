/**
 * Tests for the long-polling retry policy: exponential backoff with jitter,
 * reset after a good poll, Retry-After, the 401 pause and stop during a pause.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MaxApiError } from './api.js';
import { POLL_AUTH_PAUSE_MS, resolvePollRetryDelayMs, startMaxPollingLoop } from './polling.js';

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
  let log: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

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
    log = { info: vi.fn(), error: vi.fn() };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
