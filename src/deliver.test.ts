/**
 * Tests for reply delivery failures: plain-text fallback when MAX refuses the
 * markup, SDK delivery errors (not dispatched / partial delivery) and long
 * final answers in edit streaming.
 */

import { isChannelPartialDeliveryError } from 'openclaw/plugin-sdk/channel-inbound';
import { PlatformMessageNotDispatchedError } from 'openclaw/plugin-sdk/error-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MaxApiError } from './api.js';
import { deliverMaxReply, toMaxDeliveryError } from './deliver.js';
import { setMaxRuntime } from './runtime.js';
import { answerMaxCallback, editMaxMessage, isMaxFormatRejection, sendMaxMessage } from './send.js';
import { createMaxDraftStream } from './stream-draft.js';

type Call = { method: string; url: string; body: Record<string, unknown> };

const ACCOUNT = {
  accountId: 'default',
  enabled: true,
  token: 'test-token',
  tokenSource: 'config' as const,
  config: {},
};
const LOG = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const BUTTONS = { max: { buttons: [[{ text: 'More', payload: 'more' }]] } };
const MARKUP_REFUSED = { code: 'proto.payload', message: 'Failed to parse markdown' };

let calls: Call[];

/** Queue fetch responses in order: [status, json]; the last one repeats. */
function mockFetch(...responses: [number, unknown][]) {
  calls = [];
  let index = 0;
  global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      method: String(init?.method),
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    const [status, json] = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
}

function sent(mid: string): [number, unknown] {
  return [200, { message: { body: { mid }, recipient: { chat_id: 70, chat_type: 'dialog' } } }];
}

const posts = () => calls.filter((c) => c.method === 'POST' && c.url.includes('/messages'));

function useChunks(chunks: string[] | null) {
  setMaxRuntime({
    channel: {
      text: {
        resolveChunkMode: vi.fn(() => 'length'),
        chunkMarkdownTextWithMode: vi.fn((text: string) => chunks ?? [text]),
      },
    },
  } as never);
}

function deliver(payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return deliverMaxReply({
    payload,
    account: ACCOUNT,
    chatId: '70',
    config: { channels: {} },
    log: LOG,
    ...extra,
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

beforeEach(() => {
  vi.clearAllMocks();
  useChunks(null);
});

describe('plain-text fallback on a markup refusal', () => {
  it('resends a refused markdown message once as plain text', async () => {
    mockFetch([400, MARKUP_REFUSED], sent('mid.plain'));

    const result = await sendMaxMessage('70', '**bold** text', {
      token: 'test-token',
      format: 'markdown',
      buttons: [[{ text: 'Ok' }]],
    });

    expect(result.messageId).toBe('mid.plain');
    expect(posts()).toHaveLength(2);
    expect(posts()[0].body.format).toBe('markdown');
    expect(posts()[1].body.format).toBeUndefined();
    expect(posts()[1].body.text).toBe('**bold** text');
    // The keyboard survives the fallback.
    expect(posts()[1].body.attachments).toHaveLength(1);
  });

  it('falls back only once: a second refusal propagates', async () => {
    mockFetch([400, MARKUP_REFUSED]);

    const err = await rejection(sendMaxMessage('70', 'text', { token: 't', format: 'markdown' }));

    expect(err).toBeInstanceOf(MaxApiError);
    expect(posts()).toHaveLength(2);
  });

  it('does not fall back for 5xx, unformatted text or a missing chat', async () => {
    mockFetch([500, { code: 'internal' }]);
    await rejection(sendMaxMessage('70', 'text', { token: 't', format: 'markdown' }));
    expect(posts()).toHaveLength(1);

    mockFetch([400, MARKUP_REFUSED]);
    await rejection(sendMaxMessage('70', 'text', { token: 't' }));
    expect(posts()).toHaveLength(1);

    expect(isMaxFormatRejection(new MaxApiError('x', 400, { code: 'chat.not.found' }))).toBe(false);
    expect(isMaxFormatRejection(new MaxApiError('x', 400, { code: 'attachment.not.ready' }))).toBe(
      false,
    );
    expect(isMaxFormatRejection(new MaxApiError('x', 403, MARKUP_REFUSED))).toBe(false);
    expect(isMaxFormatRejection(new MaxApiError('x', 400, MARKUP_REFUSED))).toBe(true);
  });

  it('applies to edits and callback answers', async () => {
    mockFetch([400, MARKUP_REFUSED], [200, { success: true }]);
    await editMaxMessage('mid.1', '_x_', { token: 't', format: 'markdown' });
    expect(calls.map((c) => c.body.format)).toEqual(['markdown', undefined]);

    mockFetch([400, MARKUP_REFUSED], [200, { success: true }]);
    await answerMaxCallback('cb.1', '_x_', { token: 't', format: 'markdown' });
    expect(calls.map((c) => (c.body.message as { format?: string }).format)).toEqual([
      'markdown',
      undefined,
    ]);
  });
});

describe('delivery errors follow the SDK contract', () => {
  it('rejects a refused send as not dispatched (permanent)', async () => {
    mockFetch([403, { code: 'chat.denied', message: 'denied' }]);

    const err = await rejection(deliver({ text: 'hello' }));

    expect(err).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect((err as PlatformMessageNotDispatchedError).retryable).toBe(false);
    expect((err as Error).cause).toBeInstanceOf(MaxApiError);
    expect(LOG.error).toHaveBeenCalledWith(expect.stringContaining('chat.denied'));
  });

  it('marks an exhausted rate limit as retryable, and rethrows ambiguous 5xx as is', () => {
    const limited = toMaxDeliveryError(new MaxApiError('x', 429), { messageIds: [], texts: [] });
    expect((limited as PlatformMessageNotDispatchedError).retryable).toBe(true);

    const upstream = new MaxApiError('x', 502);
    expect(toMaxDeliveryError(upstream, { messageIds: [], texts: [] })).toBe(upstream);
  });

  it('keeps the delivered chunks on a partial failure and stops the text', async () => {
    useChunks(['part 1', 'part 2', 'part 3']);
    mockFetch(sent('mid.1'), [500, { code: 'internal' }]);

    const err = await rejection(deliver({ text: 'long answer', channelData: BUTTONS }));

    expect(isChannelPartialDeliveryError(err)).toBe(true);
    const result = (err as { deliveryResult: Record<string, unknown> }).deliveryResult;
    expect(result).toMatchObject({
      visibleReplySent: true,
      messageIds: ['mid.1'],
      content: 'part 1',
    });
    // part 3 is not sent after the gap.
    expect(posts().map((c) => c.body.text)).toEqual(['part 1', 'part 2']);
  });

  it('still sends media after a text failure and reports the media as visible', async () => {
    mockFetch([403, { code: 'chat.denied' }], sent('mid.media'));

    const err = await rejection(
      deliver({ text: 'caption', mediaUrls: ['https://cdn.example.test/a.png'] }),
    );

    expect(isChannelPartialDeliveryError(err)).toBe(true);
    expect((err as { deliveryResult: { messageIds: string[] } }).deliveryResult.messageIds).toEqual(
      ['mid.media'],
    );
  });

  it('rejects a media failure after delivered text as partial', async () => {
    mockFetch(sent('mid.text'), [400, { code: 'bad.media' }]);

    const err = await rejection(
      deliver({ text: 'here', mediaUrls: ['https://cdn.example.test/a.png'] }),
    );

    expect(isChannelPartialDeliveryError(err)).toBe(true);
    expect((err as { deliveryResult: { messageIds: string[] } }).deliveryResult.messageIds).toEqual(
      ['mid.text'],
    );
  });

  it('rejects a failed callback answer instead of swallowing it', async () => {
    mockFetch([400, { code: 'callback.expired' }]);

    const err = await rejection(deliver({ text: 'answer' }, { callbackId: 'cb.1' }));

    expect(err).toBeInstanceOf(PlatformMessageNotDispatchedError);
  });

  it('resolves cleanly when everything is delivered, buttons on the last chunk', async () => {
    useChunks(['part 1', 'part 2']);
    mockFetch(sent('mid.1'), sent('mid.2'));

    await deliver({ text: 'long answer', channelData: BUTTONS });

    expect(posts().map((c) => Boolean(c.body.attachments))).toEqual([false, true]);
  });
});

describe('edit streaming: long and refused finals', () => {
  async function startDraft() {
    const draft = createMaxDraftStream({ account: ACCOUNT, chatId: '70', log: LOG });
    await draft.update('Draft of the answer, long enough to be sent');
    expect(draft.messageId).toBe('mid.draft');
    return draft;
  }

  it('puts the first chunk into the draft and sends the rest, buttons on the last', async () => {
    useChunks(['chunk 1', 'chunk 2', 'chunk 3']);
    mockFetch(sent('mid.draft'), [200, { success: true }], sent('mid.2'), sent('mid.3'));
    const draft = await startDraft();

    await deliver({ text: 'x'.repeat(9000), channelData: BUTTONS }, { draft });

    const edits = calls.filter((c) => c.method === 'PUT');
    expect(edits).toHaveLength(1);
    expect(edits[0].url).toContain('message_id=mid.draft');
    expect(edits[0].body.text).toBe('chunk 1');
    expect(edits[0].body.attachments).toBeUndefined();
    const newMessages = posts().slice(1);
    expect(newMessages.map((c) => c.body.text)).toEqual(['chunk 2', 'chunk 3']);
    expect(newMessages.map((c) => Boolean(c.body.attachments))).toEqual([false, true]);
  });

  it('sends the answer as new messages when the draft edit is refused', async () => {
    useChunks(['chunk 1', 'chunk 2']);
    mockFetch(
      sent('mid.draft'),
      [404, { code: 'not.found' }],
      [200, { success: true }],
      sent('mid.1'),
      sent('mid.2'),
    );
    const draft = await startDraft();

    await deliver({ text: 'answer', channelData: BUTTONS }, { draft });

    expect(calls.map((c) => c.method)).toEqual(['POST', 'PUT', 'DELETE', 'POST', 'POST']);
    expect(calls[2].url).toContain('message_id=mid.draft');
    const newMessages = posts().slice(1);
    expect(newMessages.map((c) => c.body.text)).toEqual(['chunk 1', 'chunk 2']);
    expect(newMessages.map((c) => Boolean(c.body.attachments))).toEqual([false, true]);
    expect(LOG.warn).toHaveBeenCalledWith(expect.stringContaining('draft final edit failed'));
  });

  it('counts a draft it could not replace or delete as visible on failure', async () => {
    mockFetch(sent('mid.draft'), [404, { code: 'not.found' }], [500, {}], [500, {}]);
    const draft = await startDraft();

    const err = await rejection(deliver({ text: 'answer' }, { draft }));

    expect(isChannelPartialDeliveryError(err)).toBe(true);
    expect((err as { deliveryResult: { messageIds: string[] } }).deliveryResult.messageIds).toEqual(
      ['mid.draft'],
    );
  });

  it('skips the edit when the draft already shows the final text', async () => {
    mockFetch(sent('mid.draft'));
    const draft = await startDraft();

    await deliver({ text: 'Draft of the answer, long enough to be sent' }, { draft });

    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });
});
