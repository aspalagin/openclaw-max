/**
 * Tests for the inbound pipeline: forwarded messages (link.type 'forward',
 * including forward-only messages with body = null) and reply quotes, over
 * both transports (polling dispatches updates directly, the webhook after
 * the JSON round trip).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MaxUpdate } from './api.js';
import { dispatchUpdate } from './dispatch.js';
import { setMaxRuntime } from './runtime.js';
import {
  handleMaxWebhookRequest,
  maxUpdateDedupeKey,
  registerMaxWebhookTarget,
} from './webhook.js';

const SENDER = { user_id: 1001, first_name: 'Anna', is_bot: false };
const AUTHOR = { user_id: 2002, first_name: 'Ivan', last_name: 'Petrov', is_bot: false };
const DIALOG = { chat_id: 5005, chat_type: 'dialog' };
const GROUP = { chat_id: -7007, chat_type: 'chat' };
const IMAGE = { type: 'image', payload: { url: 'https://files.example.test/fwd.jpg' } };

function makeRuntime() {
  const dispatched: Record<string, unknown>[] = [];
  const fetchRemoteMedia = vi.fn(async ({ url }: { url: string }) => ({
    buffer: new Uint8Array([1, 2, 3]),
    contentType: 'image/jpeg',
    fileName: url.split('/').pop(),
  }));
  const saveMediaBuffer = vi.fn(async (_buf: Buffer, contentType: string) => ({
    path: '/tmp/media/inbound/fwd.jpg',
    contentType,
  }));
  const core = {
    channel: {
      pairing: { readAllowFromStore: vi.fn(async () => []) },
      routing: {
        resolveAgentRoute: vi.fn(({ peer }: { peer: { kind: string; id: string } }) => ({
          agentId: 'main',
          accountId: 'default',
          sessionKey: `agent:main:max:${peer.kind}:${peer.id}`,
        })),
      },
      session: {
        resolveStorePath: vi.fn(() => '/tmp/store'),
        readSessionUpdatedAt: vi.fn(() => undefined),
        recordSessionMetaFromInbound: vi.fn(async () => undefined),
      },
      media: { fetchRemoteMedia, saveMediaBuffer },
      text: {
        resolveChunkMode: vi.fn(() => 'length'),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        formatAgentEnvelope: vi.fn(({ body }: { body: string }) => body),
        finalizeInboundContext: (ctx: Record<string, unknown>) => ctx,
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(
          async ({ ctx }: { ctx: Record<string, unknown> }) => {
            dispatched.push(ctx);
          },
        ),
      },
    },
  };
  return { core, dispatched, fetchRemoteMedia };
}

function makeOpts(accountConfig: Record<string, unknown> = {}) {
  return {
    api: {
      sendAction: vi.fn(async () => ({ success: true })),
      getVideoInfo: vi.fn(),
      getMessages: vi.fn(),
    },
    account: {
      accountId: 'default',
      enabled: true,
      token: 'test-token',
      tokenSource: 'config' as const,
      config: { dmPolicy: 'allowlist', allowFrom: ['1001'], markSeen: false, ...accountConfig },
    },
    config: { channels: {} },
    abortSignal: new AbortController().signal,
    botUserId: 9009,
    botUsername: 'test_bot',
  };
}

function created(message: Record<string, unknown>, timestamp = 1790000000000): MaxUpdate {
  return {
    update_type: 'message_created',
    timestamp,
    message: { sender: SENDER, recipient: DIALOG, timestamp, ...message },
  } as unknown as MaxUpdate;
}

function forwardLink(message: Record<string, unknown>, sender: unknown = AUTHOR) {
  return {
    type: 'forward',
    sender,
    chat_id: 3003,
    message: { mid: 'mid.orig', seq: 1, ...message },
  };
}

describe('forwarded messages', () => {
  let runtime: ReturnType<typeof makeRuntime>;

  beforeEach(() => {
    runtime = makeRuntime();
    setMaxRuntime(runtime.core as never);
  });

  it('delivers a forward with text, marked with its author', async () => {
    await dispatchUpdate(
      created({
        body: { mid: 'mid.fwd', seq: 2, text: '' },
        link: forwardLink({ text: 'Meeting moved to 15:00' }),
      }),
      makeOpts() as never,
    );

    expect(runtime.dispatched).toHaveLength(1);
    const ctx = runtime.dispatched[0];
    expect(ctx.BodyForAgent).toBe('[Forwarded message from Ivan Petrov]\nMeeting moved to 15:00');
    expect(ctx.MessageSid).toBe('mid.fwd');
    expect(ctx.SupplementalContext).toEqual({
      forwarded: { from: 'Ivan Petrov', fromType: 'user', fromId: '2002' },
    });
  });

  it('delivers a forward-only message with body = null', async () => {
    await dispatchUpdate(
      created({ body: null, link: forwardLink({ text: 'Original text' }) }),
      makeOpts() as never,
    );

    expect(runtime.dispatched).toHaveLength(1);
    const ctx = runtime.dispatched[0];
    expect(ctx.BodyForAgent).toBe('[Forwarded message from Ivan Petrov]\nOriginal text');
    expect(ctx.RawBody).toBe('');
    // No mid of its own: a stable synthetic id (dedup) and no ReplyToId.
    expect(ctx.MessageSid).toBe('link_5005_1790000000000_mid.orig');
    expect(ctx.ReplyToId).toBeUndefined();
  });

  it('downloads the attachments of an attachment-only forward', async () => {
    await dispatchUpdate(
      created({ body: null, link: forwardLink({ text: null, attachments: [IMAGE] }) }),
      makeOpts() as never,
    );

    expect(runtime.fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://files.example.test/fwd.jpg' }),
    );
    const ctx = runtime.dispatched[0];
    expect(ctx.BodyForAgent).toBe('[Forwarded message from Ivan Petrov]');
    expect(ctx.media).toEqual([
      expect.objectContaining({ path: '/tmp/media/inbound/fwd.jpg', contentType: 'image/jpeg' }),
    ]);
  });

  it('keeps both the sender comment and the forward, comment first', async () => {
    await dispatchUpdate(
      created({
        body: { mid: 'mid.fwd', seq: 2, text: 'What do you think?' },
        link: forwardLink({ text: 'Quarterly report is ready', attachments: [IMAGE] }),
      }),
      makeOpts() as never,
    );

    const ctx = runtime.dispatched[0];
    expect(ctx.BodyForAgent).toBe(
      'What do you think?\n\n[Forwarded message from Ivan Petrov]\nQuarterly report is ready',
    );
    expect(ctx.CommandBody).toBe('What do you think?');
    expect(ctx.media).toHaveLength(1);
  });

  it('labels a channel post (no sender) by its origin chat', async () => {
    await dispatchUpdate(
      created({ body: null, link: forwardLink({ text: 'Channel news' }, null) }),
      makeOpts() as never,
    );

    const ctx = runtime.dispatched[0];
    expect(ctx.BodyForAgent).toBe('[Forwarded message from chat:3003]\nChannel news');
    expect(ctx.SupplementalContext).toEqual({
      forwarded: { from: 'chat:3003', fromType: 'channel', fromId: '3003' },
    });
  });

  it('never treats forwarded text as a command', async () => {
    await dispatchUpdate(
      created({ body: null, link: forwardLink({ text: '/reset' }) }),
      makeOpts() as never,
    );

    const ctx = runtime.dispatched[0];
    expect(ctx.CommandBody).toBe('');
    expect(ctx.CommandTurn).toBeUndefined();
    expect(ctx.BodyForAgent).toBe('[Forwarded message from Ivan Petrov]\n/reset');
  });

  it('downloads nothing from a forward blocked at the DM gate', async () => {
    await dispatchUpdate(
      created({
        sender: { user_id: 4004, first_name: 'Stranger', is_bot: false },
        body: null,
        link: forwardLink({ attachments: [IMAGE] }),
      }),
      makeOpts() as never,
    );

    expect(runtime.dispatched).toHaveLength(0);
    expect(runtime.fetchRemoteMedia).not.toHaveBeenCalled();
  });

  it('downloads nothing from a forward in a group outside the allowlist', async () => {
    await dispatchUpdate(
      created({ recipient: GROUP, body: null, link: forwardLink({ attachments: [IMAGE] }) }),
      makeOpts({ groupPolicy: 'allowlist', groups: {} }) as never,
    );

    expect(runtime.dispatched).toHaveLength(0);
    expect(runtime.fetchRemoteMedia).not.toHaveBeenCalled();
  });

  it('keeps the mention gate in groups: a bare forward does not address the bot', async () => {
    const opts = makeOpts({ groupPolicy: 'allowlist', groups: { '-7007': {} } });
    await dispatchUpdate(
      created({ recipient: GROUP, body: null, link: forwardLink({ attachments: [IMAGE] }) }),
      opts as never,
    );
    expect(runtime.dispatched).toHaveLength(0);
    expect(runtime.fetchRemoteMedia).not.toHaveBeenCalled();

    await dispatchUpdate(
      created({
        recipient: GROUP,
        body: { mid: 'mid.g', seq: 3, text: '@test_bot look' },
        link: forwardLink({ text: 'Forwarded in group', attachments: [IMAGE] }),
      }),
      opts as never,
    );
    expect(runtime.dispatched).toHaveLength(1);
    expect(runtime.fetchRemoteMedia).toHaveBeenCalledTimes(1);
  });

  it('replies to a forward-only message without a reply link', async () => {
    runtime.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn(
      async (params: unknown) => {
        const { dispatcherOptions } = params as {
          dispatcherOptions: { deliver: (payload: unknown, info: unknown) => Promise<void> };
        };
        await dispatcherOptions.deliver({ text: 'Noted' }, { kind: 'final' });
      },
    ) as never;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { body: { mid: 'mid.reply' }, recipient: DIALOG } }),
    });

    await dispatchUpdate(
      created({ body: null, link: forwardLink({ text: 'Original text' }) }),
      makeOpts() as never,
    );

    const send = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      ([url, init]) => String(url).includes('/messages') && init.method === 'POST',
    );
    expect(send).toBeDefined();
    const body = JSON.parse(send![1].body);
    expect(body.text).toBe('Noted');
    expect(body.link).toBeUndefined();
  });

  it('ignores an edit event without a body instead of throwing', async () => {
    await dispatchUpdate(
      {
        update_type: 'message_edited',
        timestamp: 1,
        message: { sender: SENDER, recipient: DIALOG, timestamp: 1, body: null },
      } as unknown as MaxUpdate,
      makeOpts() as never,
    );
    expect(runtime.dispatched).toHaveLength(0);
  });
});

describe('reply quotes', () => {
  let runtime: ReturnType<typeof makeRuntime>;

  beforeEach(() => {
    runtime = makeRuntime();
    setMaxRuntime(runtime.core as never);
  });

  function replyUpdate(quoted: Record<string, unknown>, sender: unknown = AUTHOR) {
    return created({
      body: { mid: 'mid.answer', seq: 5, text: 'Agreed' },
      link: {
        type: 'reply',
        sender,
        chat_id: 5005,
        message: { mid: 'mid.quoted', seq: 4, ...quoted },
      },
    });
  }

  it('passes the quoted text and author, keeping ReplyToId', async () => {
    await dispatchUpdate(replyUpdate({ text: 'Shall we ship on Friday?' }), makeOpts() as never);

    const ctx = runtime.dispatched[0];
    expect(ctx.ReplyToId).toBe('mid.quoted');
    expect(ctx.ReplyToIdFull).toBe('mid.quoted');
    expect(ctx.BodyForAgent).toBe('Agreed');
    expect(ctx.SupplementalContext).toEqual({
      quote: {
        id: 'mid.quoted',
        fullId: 'mid.quoted',
        body: 'Shall we ship on Friday?',
        sender: 'Ivan Petrov',
      },
    });
  });

  it('clips a long quote to 1000 characters', async () => {
    await dispatchUpdate(replyUpdate({ text: 'x'.repeat(5000) }), makeOpts() as never);

    const quote = (runtime.dispatched[0].SupplementalContext as { quote: { body: string } }).quote;
    expect(Array.from(quote.body)).toHaveLength(1000);
    expect(quote.body.endsWith('…')).toBe(true);
  });

  it('describes an attachment-only quote by attachment types, without downloading', async () => {
    await dispatchUpdate(
      replyUpdate({ text: null, attachments: [IMAGE, { type: 'inline_keyboard', payload: {} }] }),
      makeOpts() as never,
    );

    const quote = (runtime.dispatched[0].SupplementalContext as { quote: { body: string } }).quote;
    expect(quote.body).toBe('[image]');
    expect(runtime.fetchRemoteMedia).not.toHaveBeenCalled();
  });

  it('still counts a reply to the bot as a mention in groups', async () => {
    await dispatchUpdate(
      created({
        recipient: GROUP,
        body: { mid: 'mid.g2', seq: 6, text: 'thanks' },
        link: {
          type: 'reply',
          sender: { user_id: 9009, first_name: 'Bot', is_bot: true },
          chat_id: -7007,
          message: { mid: 'mid.bot', seq: 5, text: 'Done' },
        },
      }),
      makeOpts({ groupPolicy: 'allowlist', groups: { '-7007': {} } }) as never,
    );

    expect(runtime.dispatched).toHaveLength(1);
    expect(runtime.dispatched[0].WasMentioned).toBe(true);
    expect(runtime.dispatched[0].ReplyToId).toBe('mid.bot');
  });
});

describe('forwards over the webhook transport', () => {
  function request(body: string): IncomingMessage {
    const readable = new Readable({
      read() {
        this.push(body);
        this.push(null);
      },
    });
    return Object.assign(readable, {
      method: 'POST',
      url: '/fwd-hook',
      headers: { 'content-type': 'application/json', 'x-max-bot-api-secret': 'hook-secret' },
      socket: { destroyed: false, writableEnded: false },
    }) as unknown as IncomingMessage;
  }

  function response(): ServerResponse & { _status?: number } {
    const res = {
      statusCode: 200,
      _status: undefined as number | undefined,
      setHeader() {
        return res;
      },
      end() {
        res._status = res.statusCode;
      },
    };
    return res as unknown as ServerResponse & { _status?: number };
  }

  it('dispatches a body = null forward received as JSON', async () => {
    const runtime = makeRuntime();
    setMaxRuntime(runtime.core as never);
    const opts = makeOpts();
    let settled!: Promise<void>;
    const unregister = registerMaxWebhookTarget({
      account: opts.account,
      config: opts.config,
      path: '/fwd-hook',
      secret: 'hook-secret',
      onUpdate: (update) => {
        settled = dispatchUpdate(update, opts as never);
        return settled;
      },
    });

    const res = response();
    const update = created({ body: null, link: forwardLink({ text: 'Via webhook' }) });
    await handleMaxWebhookRequest(request(JSON.stringify(update)), res);
    await vi.waitFor(() => expect(settled).toBeDefined());
    await settled;
    unregister();

    expect(res._status).toBe(200);
    expect(runtime.dispatched).toHaveLength(1);
    expect(runtime.dispatched[0].BodyForAgent).toBe(
      '[Forwarded message from Ivan Petrov]\nVia webhook',
    );
  });

  it('keys redelivery dedup of a forward-only message by the linked mid', () => {
    expect(maxUpdateDedupeKey(created({ body: null, link: forwardLink({ text: 'a' }) }, 7))).toBe(
      'message_created:7:mid.orig',
    );
  });
});

describe('inbound media count limit', () => {
  it('shares one mediaMaxCount budget between own and forwarded attachments', async () => {
    const runtime = makeRuntime();
    setMaxRuntime(runtime.core as never);
    await dispatchUpdate(
      created({
        body: { mid: 'mid.lim', seq: 3, text: 'look', attachments: [IMAGE, IMAGE] },
        link: forwardLink({ text: 'Original', attachments: [IMAGE, IMAGE] }),
      }),
      makeOpts({ mediaMaxCount: 3 }) as never,
    );

    expect(runtime.fetchRemoteMedia).toHaveBeenCalledTimes(3);
    expect(String(runtime.dispatched[0].BodyForAgent)).toContain(
      '[1 more media attachment(s) not loaded: limit of 3 per message]',
    );
  });
});

describe('inbound voice messages', () => {
  const VOICE = { type: 'audio', payload: { url: 'https://files.example.test/v.ogg' } };

  function voiceRuntime() {
    const runtime = makeRuntime();
    // MAX CDNs may answer with a generic type; the explicit kind still marks audio.
    runtime.fetchRemoteMedia.mockImplementation(async () => ({
      buffer: new Uint8Array([1, 2, 3]),
      contentType: 'application/octet-stream',
      fileName: 'v.ogg',
    }));
    setMaxRuntime(runtime.core as never);
    return runtime;
  }

  it('hands a voice without a MAX transcript to core STT as an audio fact', async () => {
    const runtime = voiceRuntime();
    await dispatchUpdate(
      created({ body: { mid: 'mid.v1', seq: 1, text: '', attachments: [VOICE] } }),
      makeOpts() as never,
    );

    expect(runtime.dispatched).toHaveLength(1);
    const ctx = runtime.dispatched[0];
    expect(ctx.media).toEqual([expect.objectContaining({ kind: 'audio', messageId: 'mid.v1' })]);
    expect((ctx.media as { transcribed?: boolean }[])[0].transcribed).not.toBe(true);
    // Media-only: body and command text stay empty for core to fill from STT.
    expect(ctx.BodyForAgent).toBe('');
    expect(ctx.CommandBody).toBe('');
  });

  it('uses the MAX transcript and marks the fact transcribed so core skips STT', async () => {
    const runtime = voiceRuntime();
    await dispatchUpdate(
      created({
        body: {
          mid: 'mid.v2',
          seq: 2,
          text: '',
          attachments: [{ ...VOICE, transcription: ' Привет, бот ' }],
        },
      }),
      makeOpts() as never,
    );

    const ctx = runtime.dispatched[0];
    expect(ctx.BodyForAgent).toBe('[Voice transcript: Привет, бот]');
    expect(ctx.media).toEqual([expect.objectContaining({ kind: 'audio', transcribed: true })]);
  });

  it('marks a voice that could not be loaded instead of leaking its signed URL', async () => {
    const runtime = voiceRuntime();
    runtime.fetchRemoteMedia.mockRejectedValue(new Error('HTTP 403'));
    await dispatchUpdate(
      created({ body: { mid: 'mid.v3', seq: 3, text: '', attachments: [VOICE] } }),
      makeOpts() as never,
    );

    const ctx = runtime.dispatched[0];
    expect(ctx.BodyForAgent).toBe('[Voice message: audio unavailable, no transcript]');
    expect(String(ctx.BodyForAgent)).not.toContain('https://');
    expect(ctx.media).toBeUndefined();
  });

  it('keeps the MAX transcript when the audio cannot be loaded', async () => {
    const runtime = voiceRuntime();
    runtime.fetchRemoteMedia.mockRejectedValue(new Error('HTTP 403'));
    await dispatchUpdate(
      created({
        body: { mid: 'mid.v4', seq: 4, text: '', attachments: [{ ...VOICE, transcription: 'да' }] },
      }),
      makeOpts() as never,
    );

    expect(runtime.dispatched[0].BodyForAgent).toBe('[Voice transcript: да]');
  });

  it('logs an empty message (no text, attachments or forward) and dispatches nothing', async () => {
    const runtime = voiceRuntime();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    await dispatchUpdate(created({ body: { mid: 'mid.v5', seq: 5, text: '' } }), {
      ...makeOpts(),
      log,
    } as never);

    expect(runtime.dispatched).toHaveLength(0);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Skipping empty message mid.v5'));
  });

  it('delivers the same audio fact over the webhook transport', async () => {
    const runtime = voiceRuntime();
    const opts = makeOpts();
    let settled!: Promise<void>;
    const unregister = registerMaxWebhookTarget({
      account: opts.account,
      config: opts.config,
      path: '/voice-hook',
      secret: 'hook-secret',
      onUpdate: (update) => {
        settled = dispatchUpdate(update, opts as never);
        return settled;
      },
    });
    const req = Object.assign(
      new Readable({
        read() {
          this.push(
            JSON.stringify(
              created({ body: { mid: 'mid.v6', seq: 6, text: '', attachments: [VOICE] } }),
            ),
          );
          this.push(null);
        },
      }),
      {
        method: 'POST',
        url: '/voice-hook',
        headers: { 'content-type': 'application/json', 'x-max-bot-api-secret': 'hook-secret' },
        socket: { destroyed: false, writableEnded: false },
      },
    ) as unknown as IncomingMessage;
    const res = { statusCode: 200, setHeader: () => res, end: () => undefined };
    await handleMaxWebhookRequest(req, res as unknown as ServerResponse);
    await vi.waitFor(() => expect(settled).toBeDefined());
    await settled;
    unregister();

    expect(runtime.dispatched[0].media).toEqual([expect.objectContaining({ kind: 'audio' })]);
  });
});
