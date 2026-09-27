/**
 * Tests for the webhook update queue: dispatch runs in the account task's
 * async context (not the request's), per-chat order, bounded cross-chat
 * parallelism, abort and handover of undispatched updates.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MaxApi, MaxUpdate } from './api.js';
import { startMaxPolling } from './monitor.js';
import { maxTurnAdoptionReplyOptions } from './turn-adoption.js';
import { openMaxUpdateJournal, resetMaxUpdateJournalsForTest } from './update-journal.js';
import { handleMaxWebhookRequest } from './webhook.js';
import {
  createMaxWebhookUpdateQueue,
  MaxWebhookQueueRejectedError,
  resetMaxWebhookHandoversForTest,
} from './webhook-queue.js';

const dispatchCalls = vi.hoisted(() => ({ fn: undefined as undefined | ((u: unknown) => void) }));
vi.mock('./dispatch.js', () => ({
  dispatchUpdate: vi.fn(async (update: unknown) => dispatchCalls.fn?.(update)),
}));

function makeMsgUpdate(chatId: number, mid: string, timestamp = Date.now()): MaxUpdate {
  return {
    update_type: 'message_created',
    timestamp,
    message: { body: { mid }, timestamp, recipient: { chat_id: chatId } },
  } as MaxUpdate;
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  resetMaxWebhookHandoversForTest();
  resetMaxUpdateJournalsForTest();
  dispatchCalls.fn = undefined;
});

/** Process restart or crash: in-memory queues and journals are gone, the disk stays. */
const restartProcess = () => {
  resetMaxWebhookHandoversForTest();
  resetMaxUpdateJournalsForTest();
};

const journalDir = () => join(mkdtempSync(join(tmpdir(), 'max-queue-')), 'inbox');

const midOf = (u: MaxUpdate) => u.message?.body?.mid;

/** Consume until `count` dispatches, then stop; returns the dispatched mids. */
async function drain(
  queue: ReturnType<typeof createMaxWebhookUpdateQueue>,
  count: number,
): Promise<Array<string | undefined>> {
  const mids: Array<string | undefined> = [];
  const controller = new AbortController();
  const done = queue.consume({
    dispatch: async (u) => {
      mids.push(midOf(u));
    },
    abortSignal: controller.signal,
    onError: () => {},
  });
  await vi.waitFor(() => expect(mids).toHaveLength(count));
  await tick();
  controller.abort();
  await done;
  return mids;
}

describe('createMaxWebhookUpdateQueue', () => {
  it('dispatches in the consumer (account task) context, not the pushing request context', async () => {
    // Models the gateway's root-work admission store: the request scope is
    // released after the handler, so work must not inherit it.
    const admission = new AsyncLocalStorage<string>();
    const seen: Array<string | undefined> = [];
    const queue = createMaxWebhookUpdateQueue({ accountId: 'ctx' });
    const controller = new AbortController();

    const consumer = admission.run('account-task', () =>
      queue.consume({
        dispatch: async () => {
          seen.push(admission.getStore());
          await tick(1);
          seen.push(admission.getStore());
        },
        abortSignal: controller.signal,
        onError: () => {},
      }),
    );

    admission.run('http:request', () => {
      queue.push(makeMsgUpdate(1, 'a'));
      queue.push(makeMsgUpdate(2, 'b'));
    });
    await tick();
    admission.run('http:request', () => queue.push(makeMsgUpdate(1, 'c')));
    await vi.waitFor(() => expect(seen).toHaveLength(6));
    controller.abort();
    await consumer;

    expect(new Set(seen)).toEqual(new Set(['account-task']));
  });

  it('serializes one chat and does not block other chats behind it', async () => {
    const order: string[] = [];
    const slow = deferred();
    const queue = createMaxWebhookUpdateQueue({ accountId: 'order' });
    const controller = new AbortController();
    const consumer = queue.consume({
      dispatch: async (u) => {
        const mid = String(u.message?.body?.mid);
        order.push(`start:${mid}`);
        if (mid === 'a') await slow.promise;
        order.push(`end:${mid}`);
      },
      abortSignal: controller.signal,
      onError: () => {},
    });

    queue.push(makeMsgUpdate(1, 'a'));
    queue.push(makeMsgUpdate(1, 'b'));
    queue.push(makeMsgUpdate(2, 'x'));
    await tick();
    expect(order).toEqual(['start:a', 'start:x', 'end:x']);

    slow.resolve();
    await tick();
    expect(order).toEqual(['start:a', 'start:x', 'end:x', 'end:a', 'start:b', 'end:b']);
    controller.abort();
    await consumer;
  });

  it('caps parallel chats at the concurrency limit', async () => {
    const gate = deferred();
    let running = 0;
    let peak = 0;
    const queue = createMaxWebhookUpdateQueue({ accountId: 'cap', concurrency: 2 });
    const controller = new AbortController();
    const consumer = queue.consume({
      dispatch: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
      },
      abortSignal: controller.signal,
      onError: () => {},
    });
    for (const chat of [1, 2, 3, 4]) queue.push(makeMsgUpdate(chat, `m${chat}`));
    await tick();
    expect(running).toBe(2);
    gate.resolve();
    await tick();
    expect(peak).toBe(2);
    expect(running).toBe(0);
    controller.abort();
    await consumer;
  });

  it('logs a dispatch error and keeps the lane going', async () => {
    const onError = vi.fn();
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const queue = createMaxWebhookUpdateQueue({ accountId: 'err' });
    const controller = new AbortController();
    const consumer = queue.consume({ dispatch, abortSignal: controller.signal, onError });
    queue.push(makeMsgUpdate(1, 'bad'));
    queue.push(makeMsgUpdate(1, 'good'));
    await tick();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
    controller.abort();
    await consumer;
  });

  it('stops on abort and hands undispatched updates to the next start of the account', async () => {
    const slow = deferred();
    const first: string[] = [];
    const onWarn = vi.fn();
    const q1 = createMaxWebhookUpdateQueue({ accountId: 'handover', stopGraceMs: 20 });
    const c1 = new AbortController();
    const consumer1 = q1.consume({
      dispatch: async (u) => {
        first.push(String(u.message?.body?.mid));
        await slow.promise;
      },
      abortSignal: c1.signal,
      onError: () => {},
      onWarn,
    });
    q1.push(makeMsgUpdate(1, 'a'));
    q1.push(makeMsgUpdate(1, 'b'));
    await tick();
    c1.abort();
    await consumer1; // returns after the grace period even with 'a' still running
    q1.push(makeMsgUpdate(1, 'c')); // late push after stop
    expect(first).toEqual(['a']);
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/handed over/));

    const second: string[] = [];
    const q2 = createMaxWebhookUpdateQueue({ accountId: 'handover' });
    const c2 = new AbortController();
    const consumer2 = q2.consume({
      dispatch: async (u) => {
        second.push(String(u.message?.body?.mid));
      },
      abortSignal: c2.signal,
      onError: () => {},
    });
    q2.push(makeMsgUpdate(1, 'd'));
    await tick();
    // Waits for the predecessor's in-flight 'a' to keep chat order.
    expect(second).toEqual([]);
    slow.resolve();
    await tick();
    expect(second).toEqual(['b', 'c', 'd']);
    c2.abort();
    await consumer2;
  });

  it('moves leftovers to an already running successor of the same account', async () => {
    const slow = deferred();
    const q1 = createMaxWebhookUpdateQueue({ accountId: 'overlap', stopGraceMs: 5 });
    const c1 = new AbortController();
    const consumer1 = q1.consume({
      dispatch: () => slow.promise,
      abortSignal: c1.signal,
      onError: () => {},
    });
    q1.push(makeMsgUpdate(1, 'a'));
    q1.push(makeMsgUpdate(1, 'b'));
    await tick();

    const got: string[] = [];
    const q2 = createMaxWebhookUpdateQueue({ accountId: 'overlap' });
    const c2 = new AbortController();
    const consumer2 = q2.consume({
      dispatch: async (u) => {
        got.push(String(u.message?.body?.mid));
      },
      abortSignal: c2.signal,
      onError: () => {},
    });
    c1.abort();
    await consumer1;
    await tick();
    expect(got).toEqual(['b']);
    slow.resolve();
    c2.abort();
    await consumer2;
  });

  it('drops pushes beyond the pending limit with a warning', async () => {
    const onWarn = vi.fn();
    const gate = deferred();
    const queue = createMaxWebhookUpdateQueue({ accountId: 'limit', pendingLimit: 2 });
    const controller = new AbortController();
    const dispatch = vi.fn(() => gate.promise);
    const consumer = queue.consume({
      dispatch,
      abortSignal: controller.signal,
      onError: () => {},
      onWarn,
    });
    queue.push(makeMsgUpdate(1, 'a'));
    queue.push(makeMsgUpdate(1, 'b'));
    queue.push(makeMsgUpdate(1, 'c'));
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/queue full/));
    gate.resolve();
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
    controller.abort();
    await consumer;
  });
});

describe('durable webhook queue', () => {
  it('dispatches updates accepted before a crash after the restart, first and in order', async () => {
    const dir = journalDir();
    const before = createMaxWebhookUpdateQueue({
      accountId: 'd1',
      journal: await openMaxUpdateJournal({ accountId: 'd1', dir }),
    });
    expect(await before.admit(makeMsgUpdate(1, 'm1'), 'k1')).toBe('queued');
    expect(await before.admit(makeMsgUpdate(1, 'm2'), 'k2')).toBe('queued');
    // Acked to MAX, never dispatched: the gateway dies here.
    restartProcess();

    const after = createMaxWebhookUpdateQueue({
      accountId: 'd1',
      journal: await openMaxUpdateJournal({ accountId: 'd1', dir }),
    });
    expect(await after.recover()).toEqual({ recovered: 2, stale: 0, unreadable: 0 });
    expect(await after.admit(makeMsgUpdate(1, 'm3'), 'k3')).toBe('queued');
    expect(await drain(after, 3)).toEqual(['m1', 'm2', 'm3']);
    // Handled updates leave only their dedupe keys behind.
    expect(readdirSync(dir)).toEqual(['completed.json']);
  });

  it('rejects a redelivery of a handled update after a restart', async () => {
    const dir = journalDir();
    const first = createMaxWebhookUpdateQueue({
      accountId: 'd2',
      journal: await openMaxUpdateJournal({ accountId: 'd2', dir }),
    });
    const update = makeMsgUpdate(1, 'm1');
    await first.admit(update, 'k1');
    expect(await drain(first, 1)).toEqual(['m1']);
    restartProcess();

    const second = createMaxWebhookUpdateQueue({
      accountId: 'd2',
      journal: await openMaxUpdateJournal({ accountId: 'd2', dir }),
    });
    await second.recover();
    expect(await second.admit(update, 'k1')).toBe('duplicate');
    expect(readdirSync(dir)).toEqual(['completed.json']);
  });

  it('refuses beyond maxPending with overflow "reject" and drops with "drop"', async () => {
    const dir = journalDir();
    const journal = await openMaxUpdateJournal({ accountId: 'd3', dir });
    const strict = createMaxWebhookUpdateQueue({ accountId: 'd3', journal, pendingLimit: 1 });
    await strict.admit(makeMsgUpdate(1, 'm1'), 'k1');
    await expect(strict.admit(makeMsgUpdate(1, 'm2'), 'k2')).rejects.toBeInstanceOf(
      MaxWebhookQueueRejectedError,
    );
    // Not journaled: MAX redelivers it later.
    expect(readdirSync(dir).filter((n) => n.startsWith('u-'))).toHaveLength(1);
    expect(journal.isDuplicate('k2')).toBe(false);

    const warn = vi.fn();
    const lenient = createMaxWebhookUpdateQueue({
      accountId: 'd3b',
      pendingLimit: 1,
      overflow: 'drop',
      onWarn: warn,
    });
    await lenient.admit(makeMsgUpdate(1, 'm1'));
    expect(await lenient.admit(makeMsgUpdate(1, 'm2'))).toBe('dropped');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('queue full'));
  });

  it('skips stale messages, at admission and on recovery, but not registry updates', async () => {
    const dir = journalDir();
    let now = 10_000_000;
    const clock = () => now;
    const warn = vi.fn();
    const first = createMaxWebhookUpdateQueue({
      accountId: 'd4',
      journal: await openMaxUpdateJournal({ accountId: 'd4', dir, now: clock }),
      maxAgeMs: 60_000,
      now: clock,
      onWarn: warn,
    });
    expect(await first.admit(makeMsgUpdate(1, 'old', now - 60_001), 'k0')).toBe('stale');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('older than maxEventAgeMinutes'));
    await first.admit(makeMsgUpdate(1, 'fresh', now), 'k1');
    const added = { update_type: 'bot_added', timestamp: 1, chat_id: 5 } as MaxUpdate;
    expect(await first.admit(added, 'k2')).toBe('queued');
    restartProcess();

    // Down for more than the limit: the message is not answered, bot_added still counts.
    now += 120_000;
    const second = createMaxWebhookUpdateQueue({
      accountId: 'd4',
      journal: await openMaxUpdateJournal({ accountId: 'd4', dir, now: clock }),
      maxAgeMs: 60_000,
      now: clock,
    });
    expect(await second.recover()).toEqual({ recovered: 1, stale: 1, unreadable: 0 });
    expect(await drain(second, 1)).toEqual([undefined]);
    expect(readdirSync(dir)).toEqual(['completed.json']);
  });

  it('skips a damaged journal row and dispatches the rest', async () => {
    const dir = journalDir();
    const first = createMaxWebhookUpdateQueue({
      accountId: 'd5',
      journal: await openMaxUpdateJournal({ accountId: 'd5', dir }),
    });
    await first.admit(makeMsgUpdate(1, 'm1'), 'k1');
    writeFileSync(join(dir, 'u-0000000000001-000000.json'), '{broken');
    restartProcess();

    const second = createMaxWebhookUpdateQueue({
      accountId: 'd5',
      journal: await openMaxUpdateJournal({ accountId: 'd5', dir }),
    });
    expect(await second.recover()).toEqual({ recovered: 1, stale: 0, unreadable: 1 });
    expect(await drain(second, 1)).toEqual(['m1']);
  });

  it('completes the row when core adopts the turn; a crash before adoption replays it', async () => {
    const dir = journalDir();
    const first = createMaxWebhookUpdateQueue({
      accountId: 'd7',
      journal: await openMaxUpdateJournal({ accountId: 'd7', dir }),
    });
    await first.admit(makeMsgUpdate(1, 'adopted'), 'k1');
    await first.admit(makeMsgUpdate(2, 'preflight'), 'k2');
    const hang = deferred();
    const controller = new AbortController();
    void first.consume({
      dispatch: async (u) => {
        // Core adopts the first turn (and owns its recovery from here on);
        // the second dies in preflight (media download, gates).
        if (midOf(u) === 'adopted')
          await maxTurnAdoptionReplyOptions().turnAdoptionLifecycle?.onAdopted();
        await hang.promise;
      },
      abortSignal: controller.signal,
      onError: () => {},
    });
    await vi.waitFor(() =>
      expect(readdirSync(dir).filter((n) => n.startsWith('u-'))).toHaveLength(1),
    );
    // The gateway crashes mid-turn.
    restartProcess();

    const second = createMaxWebhookUpdateQueue({
      accountId: 'd7',
      journal: await openMaxUpdateJournal({ accountId: 'd7', dir }),
    });
    await second.recover();
    expect(await drain(second, 1)).toEqual(['preflight']);
    expect(maxTurnAdoptionReplyOptions()).toEqual({});
    controller.abort();
    hang.resolve();
  });

  it('keeps an entry dispatching in a stopped task out of the next task of the same process', async () => {
    const dir = journalDir();
    const journal = await openMaxUpdateJournal({ accountId: 'd6', dir });
    const first = createMaxWebhookUpdateQueue({ accountId: 'd6', journal, stopGraceMs: 1 });
    await first.admit(makeMsgUpdate(1, 'm1'), 'k1');
    const gate = deferred();
    const dispatched: Array<string | undefined> = [];
    const controller = new AbortController();
    const running = first.consume({
      dispatch: async (u) => {
        dispatched.push(midOf(u));
        await gate.promise;
      },
      abortSignal: controller.signal,
      onError: () => {},
    });
    await vi.waitFor(() => expect(dispatched).toEqual(['m1']));
    controller.abort();
    await running;

    // Config reload: a new task of the account in the same process.
    const second = createMaxWebhookUpdateQueue({
      accountId: 'd6',
      journal: await openMaxUpdateJournal({ accountId: 'd6', dir }),
    });
    expect(await second.recover()).toEqual({ recovered: 0, stale: 0, unreadable: 0 });
    gate.resolve();
    await vi.waitFor(() => expect(readdirSync(dir)).toEqual(['completed.json']));
  });
});

describe('webhook mode end to end', () => {
  it('dispatches a webhook update from the account task, not the HTTP request scope', async () => {
    const admission = new AsyncLocalStorage<{ origin: string; released: boolean }>();
    const seen: Array<{ origin: string; released: boolean } | undefined> = [];
    dispatchCalls.fn = () => seen.push(admission.getStore());

    const api = {
      getSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }),
      subscribe: vi.fn().mockResolvedValue({ success: true }),
      unsubscribe: vi.fn(),
      getUpdates: vi.fn(),
    };
    const controller = new AbortController();
    // The gateway starts channel accounts outside any request root.
    const start = admission.run({ origin: 'account-task', released: false }, () =>
      startMaxPolling({
        api: api as unknown as MaxApi,
        account: {
          accountId: 'e2e',
          enabled: true,
          token: 't',
          tokenSource: 'config',
          config: { webhookUrl: 'https://max.example/e2e/hook', webhookSecret: 'e2e-secret' },
        },
        config: {} as OpenClawConfig,
        abortSignal: controller.signal,
        registerWebhookRoute: (() => () => {}) as never,
      }),
    );
    await vi.waitFor(() => expect(api.subscribe).toHaveBeenCalled());

    const body = JSON.stringify(makeMsgUpdate(1000101, 'mid-1'));
    const req = Object.assign(Readable.from([body]), {
      method: 'POST',
      url: '/e2e/hook',
      headers: { 'x-max-bot-api-secret': 'e2e-secret' },
      socket: { destroyed: false, writableEnded: false },
    });
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    // Like route-auth runWithGatewayHttpWorkAdmission: admission released in finally.
    const request = { origin: 'http:request', released: false };
    await admission.run(request, async () => {
      try {
        expect(await handleMaxWebhookRequest(req as never, res as never)).toBe(true);
      } finally {
        request.released = true;
      }
    });
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ origin: 'account-task', released: false });

    controller.abort();
    await start;
  });

  it('falls back to the in-memory queue when the state directory is not writable, and says so', async () => {
    const base = mkdtempSync(join(tmpdir(), 'max-state-'));
    writeFileSync(join(base, 'max'), '');
    const savedStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = base;
    const dispatched: unknown[] = [];
    dispatchCalls.fn = (u) => dispatched.push(u);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const api = {
      getSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }),
      subscribe: vi.fn().mockResolvedValue({ success: true }),
      unsubscribe: vi.fn(),
    };
    const controller = new AbortController();
    try {
      const start = startMaxPolling({
        api: api as unknown as MaxApi,
        account: {
          accountId: 'fallback',
          enabled: true,
          token: 't',
          tokenSource: 'config',
          config: { webhookUrl: 'https://max.example/fb/hook', webhookSecret: 'fb-secret' },
        },
        config: {} as OpenClawConfig,
        abortSignal: controller.signal,
        log,
        registerWebhookRoute: (() => () => {}) as never,
      });
      await vi.waitFor(() => expect(api.subscribe).toHaveBeenCalled());
      expect(String(log.warn.mock.calls.flat())).toContain(
        'durable queue unavailable (ENOTDIR); using the in-memory queue',
      );

      const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
      const body = JSON.stringify(makeMsgUpdate(1, 'mem-1'));
      const req = Object.assign(Readable.from([body]), {
        method: 'POST',
        url: '/fb/hook',
        headers: { 'x-max-bot-api-secret': 'fb-secret' },
        socket: { destroyed: false, writableEnded: false },
      });
      await handleMaxWebhookRequest(req as never, res as never);
      expect(res.statusCode).toBe(200);
      await vi.waitFor(() => expect(dispatched).toHaveLength(1));
      controller.abort();
      await start;
    } finally {
      process.env.OPENCLAW_STATE_DIR = savedStateDir;
    }
  });
});
