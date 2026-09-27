/**
 * Tests for the turn-status message (streaming.mode "progress"): shown after
 * core's start delay, edited in place at most once a second, deleted after a
 * delivered final or an unused turn, kept after an error final or a failed
 * delivery; status errors never fail the turn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedMaxAccount } from './accounts.js';
import { MaxConfigSchema } from './config-schema.js';
import { createMaxProgressDraft, MAX_PROGRESS_THROTTLE_MS } from './progress-draft.js';
import type * as SendModule from './send.js';
import { deleteMaxMessage, editMaxMessage, sendMaxMessage } from './send.js';

vi.mock('./send.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SendModule>()),
  sendMaxMessage: vi.fn(async () => ({ messageId: 'mid.status' })),
  editMaxMessage: vi.fn(async () => undefined),
  deleteMaxMessage: vi.fn(async () => undefined),
}));

const send = vi.mocked(sendMaxMessage);
const edit = vi.mocked(editMaxMessage);
const del = vi.mocked(deleteMaxMessage);

function account(streaming: Record<string, unknown> = {}): ResolvedMaxAccount {
  return {
    accountId: 'default',
    enabled: true,
    token: 'fake-progress-token',
    tokenSource: 'config',
    config: { streaming: { mode: 'progress', progress: { toolProgress: true }, ...streaming } },
  } as unknown as ResolvedMaxAccount;
}

const tool = (itemId: string, name: string) => ({
  itemId,
  kind: 'tool',
  phase: 'start',
  name,
  title: `${name} work`,
});

async function settle(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('MAX turn status (progress draft)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    send.mockClear();
    edit.mockClear();
    del.mockClear();
    send.mockImplementation(async () => ({ messageId: 'mid.status' }) as never);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows one silent plain-text status after the start delay and edits it in place', async () => {
    const progress = createMaxProgressDraft({
      account: account(),
      chatId: '5005',
      replyToId: 'mid.q',
    });
    await progress.replyOptions.onItemEvent(tool('t1', 'exec'));
    expect(send).not.toHaveBeenCalled();
    await settle(2000);
    expect(send).toHaveBeenCalledTimes(1);
    const [chatId, text, opts] = send.mock.calls[0]!;
    expect(chatId).toBe('5005');
    expect(text).toMatch(/exec/i);
    expect(opts).toMatchObject({ replyToMessageId: 'mid.q', notify: false });
    expect(opts).not.toHaveProperty('format');
    expect(progress.messageId).toBe('mid.status');

    await progress.replyOptions.onItemEvent(tool('t2', 'read'));
    await progress.replyOptions.onItemEvent(tool('t3', 'write'));
    await settle(MAX_PROGRESS_THROTTLE_MS + 100);
    expect(send).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(edit.mock.calls.at(-1)?.[0]).toBe('mid.status');
    expect(edit.mock.calls.at(-1)?.[1]).toMatch(/write/i);
    await progress.close();
  });

  it('keeps at most one MAX call per second however fast progress arrives', async () => {
    const progress = createMaxProgressDraft({ account: account(), chatId: '5005' });
    await progress.replyOptions.onItemEvent(tool('t0', 'exec'));
    await settle(2000);
    const stamps: number[] = [];
    edit.mockImplementation(async () => {
      stamps.push(Date.now());
    });
    for (let i = 1; i <= 30; i++) {
      await progress.replyOptions.onItemEvent(tool(`t${i}`, `tool${i}`));
      await settle(100);
    }
    await settle(2000);
    expect(stamps.length).toBeGreaterThan(1);
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]! - stamps[i - 1]!).toBeGreaterThanOrEqual(MAX_PROGRESS_THROTTLE_MS);
    }
    await progress.close();
  });

  it('delivers the final answer first, then deletes the status', async () => {
    const progress = createMaxProgressDraft({ account: account(), chatId: '5005' });
    await progress.replyOptions.onItemEvent(tool('t1', 'exec'));
    await settle(2000);
    const order: string[] = [];
    del.mockImplementation(async () => {
      order.push('delete');
    });
    await progress.deliverFinal({
      isError: false,
      send: async () => {
        order.push('answer');
      },
    });
    expect(order).toEqual(['answer', 'delete']);
    expect(del).toHaveBeenCalledWith('mid.status', { token: 'fake-progress-token' });
    // Late progress no longer touches the chat.
    expect(await progress.replyOptions.onItemEvent(tool('t9', 'late'))).toBe(false);
    await progress.close();
    await settle(3000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('shows nothing on a fast turn', async () => {
    const progress = createMaxProgressDraft({ account: account(), chatId: '5005' });
    await progress.replyOptions.onItemEvent(tool('t1', 'exec'));
    await progress.deliverFinal({ isError: false, send: async () => undefined });
    await progress.close();
    await settle(5000);
    expect(send).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('keeps the status after an error final and after a failed delivery', async () => {
    const errorTurn = createMaxProgressDraft({ account: account(), chatId: '5005' });
    await errorTurn.replyOptions.onItemEvent(tool('t1', 'exec'));
    await settle(2000);
    await errorTurn.deliverFinal({ isError: true, send: async () => undefined });
    await errorTurn.close();
    expect(del).not.toHaveBeenCalled();

    const failedTurn = createMaxProgressDraft({ account: account(), chatId: '5006' });
    await failedTurn.replyOptions.onItemEvent(tool('t1', 'exec'));
    await settle(2000);
    const failure = new Error('MAX 500');
    await expect(
      failedTurn.deliverFinal({
        isError: false,
        send: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    await failedTurn.close();
    expect(del).not.toHaveBeenCalled();
  });

  it('deletes an unused status at the end of the turn unless the turn failed', async () => {
    const quiet = createMaxProgressDraft({ account: account(), chatId: '5005' });
    await quiet.replyOptions.onItemEvent(tool('t1', 'exec'));
    await settle(2000);
    await quiet.close();
    expect(del).toHaveBeenCalledTimes(1);

    const failed = createMaxProgressDraft({ account: account(), chatId: '5006' });
    await failed.replyOptions.onItemEvent(tool('t1', 'exec'));
    await settle(2000);
    await failed.close({ failed: true });
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('survives status errors: no throw, no more status calls, the answer still goes out', async () => {
    send.mockRejectedValueOnce(new Error('MAX 429'));
    const progress = createMaxProgressDraft({ account: account(), chatId: '5005' });
    await progress.replyOptions.onItemEvent(tool('t1', 'exec'));
    await settle(2000);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(progress.replyOptions.onItemEvent(tool('t2', 'read'))).resolves.toBe(false);
    await settle(3000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).not.toHaveBeenCalled();
    const answer = vi.fn(async () => undefined);
    await progress.deliverFinal({ isError: false, send: answer });
    await progress.close();
    expect(answer).toHaveBeenCalledTimes(1);

    // A refused delete is logged, the delivered answer stands.
    const warn = vi.fn();
    del.mockRejectedValueOnce(new Error('MAX 404'));
    const other = createMaxProgressDraft({
      account: account(),
      chatId: '5007',
      log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
    });
    await other.replyOptions.onItemEvent(tool('t1', 'exec'));
    await settle(2000);
    await expect(other.deliverFinal({ isError: false, send: async () => undefined })).resolves.toBe(
      undefined,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('progress status delete failed'));
  });

  it('yields to verbose progress and ignores plan events other than updates', async () => {
    const progress = createMaxProgressDraft({ account: account(), chatId: '5005' });
    progress.replyOptions.onVerboseProgressVisibility(() => true);
    expect(await progress.replyOptions.onItemEvent(tool('t1', 'exec'))).toBe(false);
    expect(await progress.replyOptions.onPlanUpdate({ phase: 'start', steps: [] })).toBe(false);
    await settle(3000);
    expect(send).not.toHaveBeenCalled();
    await progress.close();
  });
});

describe('streaming config', () => {
  it('accepts core streaming settings on the channel and accounts, rejects unknown modes', () => {
    const streaming = {
      mode: 'progress',
      progress: { label: false, toolProgress: true, commandText: 'status', maxLines: 4 },
    };
    expect(MaxConfigSchema.safeParse({ streaming, accounts: { two: { streaming } } }).success).toBe(
      true,
    );
    expect(MaxConfigSchema.safeParse({ streaming: { mode: 'loud' } }).success).toBe(false);
    expect(MaxConfigSchema.safeParse({ streaming: { progress: { maxLines: 0 } } }).success).toBe(
      false,
    );
  });
});
