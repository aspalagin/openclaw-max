/**
 * Tests for reply delivery failures: plain-text fallback when MAX refuses the
 * markup, SDK delivery errors (not dispatched / partial delivery) and long
 * final answers in edit streaming.
 */

import { isChannelPartialDeliveryError } from 'openclaw/plugin-sdk/channel-inbound';
import { PlatformMessageNotDispatchedError } from 'openclaw/plugin-sdk/error-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MaxApi, MaxApiError } from './api.js';
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

  it('logs the MAX error code of the refusal, not its message or the text', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch([400, MARKUP_REFUSED], sent('mid.plain'));

    await sendMaxMessage('70', '**private** note', { token: 't', format: 'markdown' });

    expect(error).toHaveBeenCalledWith('[MAX API] POST /messages → 400 (code=proto.payload)');
    expect(warn).toHaveBeenCalledWith(
      '[MAX] markdown refused (proto.payload); resending as plain text',
    );
    const logged = [...error.mock.calls, ...warn.mock.calls].flat().join('\n');
    expect(logged).not.toContain('Failed to parse markdown');
    expect(logged).not.toContain('private');
    error.mockRestore();
    warn.mockRestore();
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

  it('logs the failed send with the MAX code but without the response body', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch([403, { code: 'chat.denied', message: 'Cannot send "hello secret"' }]);

    await rejection(deliver({ text: 'hello secret' }));

    expect(LOG.error).toHaveBeenCalledWith(
      '[default] MAX send failed: MaxApiError: MAX API POST /messages → 403 (code=chat.denied)',
    );
    expect(LOG.error.mock.calls.flat().join('\n')).not.toContain('secret');
    error.mockRestore();
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

describe('link previews of tool summaries', () => {
  const previewOff = () => posts().map((c) => c.url.includes('disable_link_preview=true'));

  it('sends tool payloads without a link preview, other kinds as configured', async () => {
    mockFetch(sent('mid.1'));
    await deliver({ text: 'Read: notes/2026-09-27.md' }, { kind: 'tool' });
    await deliver({ text: 'block' }, { kind: 'block' });
    await deliver({ text: 'final' }, { kind: 'final' });
    await deliver({ text: 'no kind' });
    expect(previewOff()).toEqual([true, false, false, false]);
  });

  it('keeps an explicit disableLinkPreview of the config or channelData', async () => {
    mockFetch(sent('mid.1'));
    await deliver(
      { text: 'Read: notes.md' },
      { kind: 'tool', account: { ...ACCOUNT, config: { disableLinkPreview: false } } },
    );
    await deliver(
      { text: 'Read: notes.md', channelData: { max: { disableLinkPreview: false } } },
      { kind: 'tool' },
    );
    await deliver(
      { text: 'final' },
      { account: { ...ACCOUNT, config: { disableLinkPreview: true } } },
    );
    expect(previewOff()).toEqual([false, false, true]);
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

  it('sends a second final payload as a new message instead of overwriting the draft', async () => {
    mockFetch(sent('mid.draft'), [200, { success: true }], sent('mid.2'));
    const draft = await startDraft();

    await deliver({ text: 'First part of the answer' }, { draft });
    await deliver({ text: 'Second part of the answer' }, { draft });

    const edits = calls.filter((c) => c.method === 'PUT');
    expect(edits).toHaveLength(1);
    expect(edits[0].body.text).toBe('First part of the answer');
    expect(posts().map((c) => c.body.text)).toEqual([
      'Draft of the answer, long enough to be sent',
      'Second part of the answer',
    ]);
  });

  it('answers a button press with the first payload only, later ones go to the chat', async () => {
    mockFetch([200, { success: true }], sent('mid.2'));
    const callbackState = { answered: false };
    const extra = { callbackId: 'cb.1', callbackState };

    await deliver({ text: 'First part of the answer' }, extra);
    await deliver({ text: 'Second part of the answer' }, extra);

    const answers = calls.filter((c) => c.url.includes('/answers'));
    expect(answers).toHaveLength(1);
    expect(answers[0].body.message).toMatchObject({ text: 'First part of the answer' });
    expect(posts().map((c) => c.body.text)).toEqual(['Second part of the answer']);
  });

  /** Like mockFetch, but the first request waits until the returned release() is called. */
  function mockSlowFirstFetch(...responses: [number, unknown][]): () => void {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    calls = [];
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const index = calls.length;
      calls.push({
        method: String(init?.method),
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      if (index === 0) await gate;
      const [status, json] = responses[Math.min(index, responses.length - 1)];
      return new Response(JSON.stringify(json), { status });
    }) as typeof fetch;
    return release;
  }

  it('waits for the first draft send in flight instead of leaving an orphan draft', async () => {
    const release = mockSlowFirstFetch(sent('mid.draft'), [200, { success: true }]);
    const draft = createMaxDraftStream({ account: ACCOUNT, chatId: '70', log: LOG });
    void draft.update('Draft of the answer, long enough to be sent');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);

    const delivered = deliver({ text: 'Final answer' }, { draft });
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await delivered;

    expect(calls.map((c) => c.method)).toEqual(['POST', 'PUT']);
    expect(calls[1].url).toContain('message_id=mid.draft');
    expect(calls[1].body.text).toBe('Final answer');
  });

  it('never sends a second draft while the first send is still in flight', async () => {
    vi.useFakeTimers();
    try {
      const release = mockSlowFirstFetch(sent('mid.draft'), [200, { success: true }]);
      const draft = createMaxDraftStream({ account: ACCOUNT, chatId: '70', log: LOG });
      void draft.update('Draft of the answer, long enough to be sent');
      void draft.update('Draft of the answer, long enough to be sent, and more');
      await vi.advanceTimersByTimeAsync(1500);
      release();
      await vi.advanceTimersByTimeAsync(1500);

      expect(calls.map((c) => c.method)).toEqual(['POST', 'PUT']);
      expect(calls[1].url).toContain('message_id=mid.draft');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the pressed message when a press answer went into the draft', async () => {
    mockFetch(sent('mid.draft'), [200, { success: true }], sent('mid.2'));
    const draft = await startDraft();
    const extra = { draft, callbackId: 'cb.1', callbackState: { answered: false } };

    await deliver({ text: 'First part of the answer' }, extra);
    await deliver({ text: 'Second part of the answer' }, extra);

    expect(calls.filter((c) => c.url.includes('/answers'))).toHaveLength(0);
    expect(posts().at(-1)?.body.text).toBe('Second part of the answer');
  });
});

describe('voice replies', () => {
  const SPOKEN = 'Ответ, который прозвучит голосом';
  let voiceFile: string;
  let localMedia: { mediaLocalRoots: string[] };
  let uploads: string[];

  beforeEach(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-voice-reply-'));
    voiceFile = path.join(dir, 'reply.mp3');
    fs.writeFileSync(voiceFile, Buffer.from('mp3-bytes'));
    localMedia = { mediaLocalRoots: [dir] };
    uploads = [];
    vi.restoreAllMocks();
    vi.spyOn(MaxApi.prototype, 'uploadMedia').mockImplementation(async (type) => {
      uploads.push(type);
      return { token: `tok:${type}` };
    });
  });

  async function startDraft() {
    const draft = createMaxDraftStream({ account: ACCOUNT, chatId: '70', log: LOG });
    await draft.update('Draft of the answer, long enough to be sent');
    expect(draft.messageId).toBe('mid.draft');
    return draft;
  }

  const texts = () => posts().map((c) => c.body.text);

  it('sends the visible text once and the audio as a voice message without a caption', async () => {
    mockFetch(sent('mid.text'), sent('mid.voice'));

    await deliver(
      { text: SPOKEN, mediaUrl: voiceFile, audioAsVoice: true, spokenText: SPOKEN },
      { localMedia },
    );

    expect(uploads).toEqual(['audio']);
    expect(texts()).toEqual([SPOKEN, undefined]);
    expect(posts()[1].body.attachments).toEqual([
      { type: 'audio', payload: { token: 'tok:audio' } },
    ]);
  });

  it('answers a button press with the text and sends the voice to the chat after it', async () => {
    mockFetch([200, { success: true }], sent('mid.voice'));

    await deliver(
      { text: SPOKEN, mediaUrl: voiceFile, audioAsVoice: true, channelData: BUTTONS },
      { callbackId: 'cb.1', localMedia },
    );

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /answers',
      'POST /messages',
    ]);
    expect((calls[0].body.message as { text: string }).text).toBe(SPOKEN);
    expect(uploads).toEqual(['audio']);
    expect(posts()[0].body).toMatchObject({
      attachments: [{ type: 'audio', payload: { token: 'tok:audio' } }],
    });
    expect(posts()[0].body.text).toBeUndefined();
  });

  it('reports the answered press as visible when the media then fails', async () => {
    mockFetch([200, { success: true }], [400, { code: 'bad.media' }]);

    const err = await rejection(
      deliver(
        { text: 'answer', mediaUrl: voiceFile, audioAsVoice: true },
        { callbackId: 'cb.1', localMedia },
      ),
    );

    expect(isChannelPartialDeliveryError(err)).toBe(true);
    expect(err).toMatchObject({ deliveryResult: { messageIds: [], content: 'answer' } });
  });

  it('still sends the media when the callback answer fails, then rejects as partial', async () => {
    mockFetch([403, { code: 'access.denied' }], sent('mid.voice'));

    const err = await rejection(
      deliver(
        { text: 'answer', mediaUrl: voiceFile, audioAsVoice: true },
        { callbackId: 'cb.1', localMedia },
      ),
    );

    expect(uploads).toEqual(['audio']);
    expect(isChannelPartialDeliveryError(err)).toBe(true);
    expect(err).toMatchObject({ deliveryResult: { messageIds: ['mid.voice'] } });
  });

  it('sends a voice-only reply as audio alone, never the spoken text', async () => {
    mockFetch(sent('mid.voice'));

    await deliver({ mediaUrl: voiceFile, audioAsVoice: true, spokenText: SPOKEN }, { localMedia });

    expect(posts()).toHaveLength(1);
    expect(texts()).toEqual([undefined]);
    expect(uploads).toEqual(['audio']);
  });

  it('removes a partial stream draft once a voice-only reply is delivered', async () => {
    mockFetch(sent('mid.draft'), sent('mid.voice'), [200, { success: true }]);
    const draft = await startDraft();

    await deliver({ mediaUrl: voiceFile, audioAsVoice: true }, { draft, localMedia });

    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'DELETE']);
    expect(calls[2].url).toContain('message_id=mid.draft');
  });

  it('keeps a draft that already carries the final text', async () => {
    mockFetch(sent('mid.draft'), [200, { success: true }], sent('mid.voice'));
    const draft = await startDraft();

    await deliver({ text: 'The final answer text' }, { draft });
    await deliver({ mediaUrl: voiceFile, audioAsVoice: true }, { draft, localMedia });

    expect(calls.map((c) => c.method)).toEqual(['POST', 'PUT', 'POST']);
  });

  it('keeps the draft when the audio could not be sent', async () => {
    mockFetch(sent('mid.draft'));
    const draft = await startDraft();
    vi.mocked(MaxApi.prototype.uploadMedia).mockRejectedValue(new Error('network down'));

    await expect(
      deliver({ mediaUrl: voiceFile, audioAsVoice: true }, { draft, localMedia }),
    ).rejects.toThrow('network down');
    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });

  it('delivers the audio as a file when MAX refuses the voice message', async () => {
    mockFetch([400, { code: 'proto.payload', message: 'bad audio' }], sent('mid.file'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await deliver({ mediaUrl: voiceFile, audioAsVoice: true }, { localMedia });

    expect(uploads).toEqual(['audio', 'file']);
    expect(posts().map((c) => (c.body.attachments as { type: string }[])[0].type)).toEqual([
      'audio',
      'file',
    ]);
  });
});

describe('channels.max.textChunkLimit', () => {
  const chunkLimitFor = async (config: Record<string, unknown>) => {
    mockFetch(sent('mid.1'));
    await deliver({ text: 'hello' }, { config });
    const runtime = (await import('./runtime.js')).getMaxRuntime();
    const chunk = runtime.channel.text.chunkMarkdownTextWithMode as unknown as ReturnType<
      typeof vi.fn
    >;
    return chunk.mock.calls.at(-1)?.[1];
  };

  it('splits replies at the configured limit, account value first', async () => {
    expect(await chunkLimitFor({ channels: {} })).toBe(4000);
    expect(await chunkLimitFor({ channels: { max: { textChunkLimit: 1500 } } })).toBe(1500);
    expect(
      await chunkLimitFor({
        channels: { max: { textChunkLimit: 1500, accounts: { default: { textChunkLimit: 800 } } } },
      }),
    ).toBe(800);
  });

  it("never goes above MAX's 4000 characters, also in core's outbound chunker", async () => {
    expect(await chunkLimitFor({ channels: { max: { textChunkLimit: 9000 } } })).toBe(4000);

    const chunkMarkdownText = vi.fn((text: string, _limit: number) => [text]);
    setMaxRuntime({ channel: { text: { chunkMarkdownText } } } as never);
    const { maxOutboundAdapter } = await import('./channel-outbound.js');
    maxOutboundAdapter.chunker?.('hello', 9000);
    maxOutboundAdapter.chunker?.('hello', 1200);
    expect(chunkMarkdownText.mock.calls.map((call) => call[1])).toEqual([4000, 1200]);
  });
});
