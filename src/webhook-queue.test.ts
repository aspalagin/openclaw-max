/**
 * Tests for the webhook update queue: dispatch runs in the account task's
 * async context (not the request's), per-chat order, bounded cross-chat
 * parallelism, abort and handover of undispatched updates.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Readable } from 'node:stream';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MaxApi, MaxUpdate } from './api.js';
import { startMaxPolling } from './monitor.js';
import { handleMaxWebhookRequest } from './webhook.js';
import { createMaxWebhookUpdateQueue, resetMaxWebhookHandoversForTest } from './webhook-queue.js';

const dispatchCalls = vi.hoisted(() => ({ fn: undefined as undefined | ((u: unknown) => void) }));
vi.mock('./dispatch.js', () => ({
  dispatchUpdate: vi.fn(async (update: unknown) => dispatchCalls.fn?.(update)),
}));

function makeMsgUpdate(chatId: number, mid: string): MaxUpdate {
  return {
    update_type: 'message_created',
    timestamp: 1,
    message: { body: { mid }, timestamp: 1, recipient: { chat_id: chatId } },
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
  dispatchCalls.fn = undefined;
});

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

    const body = JSON.stringify(makeMsgUpdate(4260364, 'mid-1'));
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
});
