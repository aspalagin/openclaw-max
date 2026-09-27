/**
 * Tests for the MAX typing indicator keepalive (SDK typing lifecycle).
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MaxApi } from './api.js';
import {
  createMaxTypingCallbacks,
  MAX_TYPING_KEEPALIVE_MS,
  sendMaxHeartbeatTyping,
} from './typing.js';

function makeApi(impl: () => Promise<unknown> = async () => ({ success: true })) {
  const sendAction = vi.fn(impl);
  return { api: { sendAction } as unknown as MaxApi, sendAction };
}

/** Let the typing lifecycle settle its promise chain (start → keepalive). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('createMaxTypingCallbacks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes typing_on while the turn runs', async () => {
    const { api, sendAction } = makeApi();
    const typing = createMaxTypingCallbacks({ api, chatId: 70, onError: vi.fn() });

    await typing.onReplyStart();
    await flush();
    expect(sendAction).toHaveBeenCalledTimes(1);
    expect(sendAction).toHaveBeenCalledWith(70, 'typing_on', {
      retryAttempts: 0,
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(MAX_TYPING_KEEPALIVE_MS * 3);
    expect(sendAction).toHaveBeenCalledTimes(4);
    typing.onIdle?.();
  });

  it('keeps the send rate far below 2 requests per second', async () => {
    const { api, sendAction } = makeApi();
    const typing = createMaxTypingCallbacks({ api, chatId: 70, onError: vi.fn() });

    await typing.onReplyStart();
    // Core re-signals reply start on its own ticks; those must not add bursts.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await typing.onReplyStart();
    }
    await vi.advanceTimersByTimeAsync(5_000);
    // 10 s of turn: at most one request per second even with the extra signals.
    expect(sendAction.mock.calls.length).toBeLessThanOrEqual(10);
    typing.onCleanup?.();
  });

  it('stops refreshing when dispatch goes idle (turn completed)', async () => {
    const { api, sendAction } = makeApi();
    const typing = createMaxTypingCallbacks({ api, chatId: 70, onError: vi.fn() });

    await typing.onReplyStart();
    await vi.advanceTimersByTimeAsync(MAX_TYPING_KEEPALIVE_MS);
    const sent = sendAction.mock.calls.length;
    typing.onIdle?.();

    await vi.advanceTimersByTimeAsync(MAX_TYPING_KEEPALIVE_MS * 5);
    expect(sendAction).toHaveBeenCalledTimes(sent);
    // A late reply-start signal after the stop does not revive the indicator.
    await typing.onReplyStart();
    expect(sendAction).toHaveBeenCalledTimes(sent);
  });

  it('stops refreshing on cleanup (error or abort path)', async () => {
    const { api, sendAction } = makeApi();
    const typing = createMaxTypingCallbacks({ api, chatId: 70, onError: vi.fn() });

    await typing.onReplyStart();
    await flush();
    typing.onCleanup?.();
    await vi.advanceTimersByTimeAsync(MAX_TYPING_KEEPALIVE_MS * 5);
    expect(sendAction).toHaveBeenCalledTimes(1);
  });

  it('stops by the safety TTL when core never signals the end', async () => {
    const { api, sendAction } = makeApi();
    const typing = createMaxTypingCallbacks({ api, chatId: 70, onError: vi.fn() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await typing.onReplyStart();
    await vi.advanceTimersByTimeAsync(60_000);
    const sent = sendAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(MAX_TYPING_KEEPALIVE_MS * 5);
    expect(sendAction).toHaveBeenCalledTimes(sent);
    warn.mockRestore();
  });

  it('logs typing failures without failing the turn and gives up after repeats', async () => {
    const { api, sendAction } = makeApi(async () => {
      throw new Error('MAX API POST /chats/70/actions → 500');
    });
    const onError = vi.fn();
    const typing = createMaxTypingCallbacks({ api, chatId: 70, onError });

    await expect(typing.onReplyStart()).resolves.toBeUndefined();
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    // The SDK breaker stops the keepalive after two failures in a row.
    await vi.advanceTimersByTimeAsync(MAX_TYPING_KEEPALIVE_MS * 5);
    expect(sendAction).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
    typing.onIdle?.();
  });
});

describe('sendMaxHeartbeatTyping', () => {
  const cfg = { channels: { max: { botToken: 'test-token' } } } as unknown as OpenClawConfig;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends typing_on to a chat target', async () => {
    const spy = vi.spyOn(MaxApi.prototype, 'sendAction').mockResolvedValue({ success: true });
    await sendMaxHeartbeatTyping({ cfg, to: 'max:-100500' });
    expect(spy).toHaveBeenCalledWith(-100500, 'typing_on', {
      retryAttempts: 0,
      timeoutMs: 5_000,
    });
  });

  it('skips user targets (the actions endpoint takes a chat id)', async () => {
    const spy = vi.spyOn(MaxApi.prototype, 'sendAction').mockResolvedValue({ success: true });
    await sendMaxHeartbeatTyping({ cfg, to: 'max:user:42' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips accounts without a token', async () => {
    const spy = vi.spyOn(MaxApi.prototype, 'sendAction').mockResolvedValue({ success: true });
    await sendMaxHeartbeatTyping({
      cfg: { channels: { max: {} } } as unknown as OpenClawConfig,
      to: 'max:70',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects on a send failure so core can log it and trip its breaker', async () => {
    vi.spyOn(MaxApi.prototype, 'sendAction').mockRejectedValue(new Error('boom'));
    await expect(sendMaxHeartbeatTyping({ cfg, to: 'max:70' })).rejects.toThrow('boom');
  });
});
