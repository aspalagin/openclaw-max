/**
 * Tests for group mentions beyond @username and markup: core's configured
 * mention patterns and captionless voice messages whose transcript (MAX's own
 * or a core preflight transcription) names the bot; the group sender allowlist.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MaxUpdate } from './api.js';
import { dispatchUpdate } from './dispatch.js';
import { setMaxRuntime } from './runtime.js';

const preflight = vi.hoisted(() => ({
  resolve: vi.fn(),
  send: vi.fn(async () => undefined),
}));

vi.mock('openclaw/plugin-sdk/media-understanding-runtime', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createChannelPreflightAudio: () => ({
    isAudio: () => true,
    suppress: (cfg: unknown) => cfg,
    format: (transcript: string) => transcript,
    resolve: preflight.resolve,
    send: preflight.send,
  }),
}));

const MEMBER = { user_id: 1001, first_name: 'Anna', is_bot: false };
const OUTSIDER = { user_id: 3003, first_name: 'Oleg', is_bot: false };
const GROUP = { chat_id: -7007, chat_type: 'chat' };
const VOICE = { type: 'audio', payload: { url: 'https://files.example.test/v.ogg' } };
const PATTERNS = { messages: { groupChat: { mentionPatterns: ['банзай'] } } };

/** Core preflight: marks the transcribed fact on the request, returns the text. */
function transcribes(text: string) {
  return async ({ request }: { request: { ctx: { media?: Array<Record<string, unknown>> } } }) => {
    request.ctx.media = (request.ctx.media ?? []).map((fact, index) =>
      index === 0 ? { ...fact, transcribed: true } : fact,
    );
    return text;
  };
}

function makeRuntime() {
  const dispatched: Record<string, unknown>[] = [];
  const fetchRemoteMedia = vi.fn(async () => ({
    buffer: new Uint8Array([1, 2, 3]),
    contentType: 'audio/ogg',
    fileName: 'v.ogg',
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
      media: {
        fetchRemoteMedia,
        saveMediaBuffer: vi.fn(async (_buf: Buffer, contentType: string) => ({
          path: '/tmp/media/inbound/v.ogg',
          contentType,
        })),
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

function makeOpts(
  config: Record<string, unknown> = PATTERNS,
  accountConfig: Record<string, unknown> = {},
) {
  return {
    api: { sendAction: vi.fn(async () => ({ success: true })) },
    account: {
      accountId: 'default',
      enabled: true,
      token: 'test-token',
      tokenSource: 'config' as const,
      config: {
        markSeen: false,
        groupPolicy: 'allowlist',
        groups: { '-7007': { requireMention: true } },
        mediaMaxMb: 5,
        ...accountConfig,
      },
    },
    config: { channels: {}, ...config },
    abortSignal: new AbortController().signal,
    botUserId: 9009,
    botUsername: 'test_bot',
  };
}

function inGroup(body: Record<string, unknown>, sender = MEMBER, recipient = GROUP): MaxUpdate {
  return {
    update_type: 'message_created',
    timestamp: 1790000000000,
    message: {
      sender,
      recipient,
      timestamp: 1790000000000,
      body: { mid: 'mid.1', seq: 1, ...body },
    },
  } as unknown as MaxUpdate;
}

describe('mention patterns in groups', () => {
  let runtime: ReturnType<typeof makeRuntime>;

  beforeEach(() => {
    runtime = makeRuntime();
    setMaxRuntime(runtime.core as never);
    preflight.resolve.mockReset();
    preflight.send.mockClear();
  });

  it('wakes the bot by a configured pattern (messages.groupChat)', async () => {
    await dispatchUpdate(inGroup({ text: 'Банзай, какие планы?' }), makeOpts() as never);

    expect(runtime.dispatched).toHaveLength(1);
    expect(runtime.dispatched[0].WasMentioned).toBe(true);
  });

  it("uses the routed agent's own patterns over the global ones", async () => {
    const config = {
      ...PATTERNS,
      agents: { list: [{ id: 'main', groupChat: { mentionPatterns: ['котик'] } }] },
    };
    await dispatchUpdate(inGroup({ text: 'Банзай, привет' }), makeOpts(config) as never);
    await dispatchUpdate(inGroup({ text: 'котик, привет' }), makeOpts(config) as never);

    expect(runtime.dispatched).toHaveLength(1);
    expect(runtime.dispatched[0].RawBody).toBe('котик, привет');
  });

  it('keeps the old behaviour without configured patterns, even with an agent name', async () => {
    const config = { agents: { list: [{ id: 'main', identity: { name: 'Банзай' } }] } };
    await dispatchUpdate(inGroup({ text: 'Банзай, привет' }), makeOpts(config) as never);
    expect(runtime.dispatched).toHaveLength(0);

    await dispatchUpdate(inGroup({ text: '@test_bot привет' }), makeOpts(config) as never);
    expect(runtime.dispatched).toHaveLength(1);
  });

  it('keeps @username and markup mentions working next to patterns', async () => {
    await dispatchUpdate(inGroup({ text: '@test_bot привет' }), makeOpts() as never);
    await dispatchUpdate(
      inGroup({
        text: 'Бот, привет',
        markup: [{ type: 'user_mention', from: 0, length: 3, user_id: 9009 }],
      }),
      makeOpts() as never,
    );

    expect(runtime.dispatched).toHaveLength(2);
  });

  it('honours the channel mentionPatterns policy (deny with allowIn)', async () => {
    const denied = { ...PATTERNS, channels: { max: { mentionPatterns: { mode: 'deny' } } } };
    await dispatchUpdate(inGroup({ text: 'Банзай, привет' }), makeOpts(denied) as never);
    expect(runtime.dispatched).toHaveLength(0);

    await dispatchUpdate(
      inGroup({ text: 'Банзай, привет' }),
      makeOpts(PATTERNS, { mentionPatterns: { mode: 'deny', allowIn: ['-7007'] } }) as never,
    );
    expect(runtime.dispatched).toHaveLength(1);
  });

  it('does not match patterns in forwarded text', async () => {
    const forward = {
      update_type: 'message_created',
      timestamp: 1790000000000,
      message: {
        sender: MEMBER,
        recipient: GROUP,
        timestamp: 1790000000000,
        body: null,
        link: {
          type: 'forward',
          sender: OUTSIDER,
          message: { mid: 'm.o', seq: 1, text: 'Банзай!' },
        },
      },
    } as unknown as MaxUpdate;
    await dispatchUpdate(forward, makeOpts() as never);

    expect(runtime.dispatched).toHaveLength(0);
  });
});

describe('voice messages in mention-gated groups', () => {
  let runtime: ReturnType<typeof makeRuntime>;

  beforeEach(() => {
    runtime = makeRuntime();
    setMaxRuntime(runtime.core as never);
    preflight.resolve.mockReset();
    preflight.send.mockClear();
  });

  it('passes a voice message whose transcript names the bot, transcribed once', async () => {
    preflight.resolve.mockImplementation(transcribes('Эй, банзай, какая погода?'));

    await dispatchUpdate(inGroup({ text: '', attachments: [VOICE] }), makeOpts() as never);

    expect(preflight.resolve).toHaveBeenCalledTimes(1);
    expect(runtime.fetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(runtime.fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ maxBytes: 5 * 1024 * 1024 }),
    );
    expect(runtime.dispatched).toHaveLength(1);
    const ctx = runtime.dispatched[0];
    expect(ctx.WasMentioned).toBe(true);
    // The transcript reaches the agent; the fact is marked so core STT skips it.
    expect(String(ctx.BodyForAgent)).toContain('Эй, банзай, какая погода?');
    expect(ctx.media).toEqual([expect.objectContaining({ kind: 'audio', transcribed: true })]);
    expect(preflight.send).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: 'Эй, банзай, какая погода?',
        originatingTo: 'max:-7007',
      }),
    );
  });

  it('drops a voice message whose transcript has no mention', async () => {
    preflight.resolve.mockImplementation(transcribes('просто разговор'));

    await dispatchUpdate(inGroup({ text: '', attachments: [VOICE] }), makeOpts() as never);

    expect(preflight.resolve).toHaveBeenCalledTimes(1);
    expect(runtime.dispatched).toHaveLength(0);
  });

  it('treats a failed or empty transcription as no mention', async () => {
    preflight.resolve.mockResolvedValueOnce(undefined);
    await dispatchUpdate(inGroup({ text: '', attachments: [VOICE] }), makeOpts() as never);

    preflight.resolve.mockRejectedValueOnce(new Error('stt down'));
    await dispatchUpdate(inGroup({ text: '', attachments: [VOICE] }), makeOpts() as never);

    runtime.fetchRemoteMedia.mockRejectedValueOnce(new Error('too large'));
    await dispatchUpdate(inGroup({ text: '', attachments: [VOICE] }), makeOpts() as never);

    expect(preflight.resolve).toHaveBeenCalledTimes(2);
    expect(runtime.dispatched).toHaveLength(0);
  });

  it("matches MAX's own transcript without downloading or transcribing", async () => {
    const voice = { ...VOICE, transcription: 'банзай, напомни про встречу' };

    await dispatchUpdate(inGroup({ text: '', attachments: [voice] }), makeOpts() as never);

    expect(preflight.resolve).not.toHaveBeenCalled();
    expect(runtime.dispatched).toHaveLength(1);
    expect(String(runtime.dispatched[0].BodyForAgent)).toContain('банзай, напомни про встречу');
  });

  it('does not transcribe without configured patterns', async () => {
    await dispatchUpdate(inGroup({ text: '', attachments: [VOICE] }), makeOpts({}) as never);

    expect(preflight.resolve).not.toHaveBeenCalled();
    expect(runtime.fetchRemoteMedia).not.toHaveBeenCalled();
    expect(runtime.dispatched).toHaveLength(0);
  });

  it('does not transcribe for groups or senders the policy does not admit', async () => {
    await dispatchUpdate(
      inGroup({ text: '', attachments: [VOICE] }, MEMBER, { chat_id: -8008, chat_type: 'chat' }),
      makeOpts() as never,
    );
    await dispatchUpdate(
      inGroup({ text: '', attachments: [VOICE] }, OUTSIDER),
      makeOpts(PATTERNS, {
        groups: { '-7007': { requireMention: true, allowFrom: ['1001'] } },
      }) as never,
    );
    await dispatchUpdate(
      inGroup({ text: '', attachments: [VOICE] }, OUTSIDER),
      makeOpts(PATTERNS, { groupAllowFrom: ['max:1001'] }) as never,
    );

    expect(preflight.resolve).not.toHaveBeenCalled();
    expect(runtime.fetchRemoteMedia).not.toHaveBeenCalled();
    expect(runtime.dispatched).toHaveLength(0);
  });

  it('skips the voice check in a group with disableAudioPreflight', async () => {
    await dispatchUpdate(
      inGroup({ text: '', attachments: [VOICE] }),
      makeOpts(PATTERNS, {
        groups: { '-7007': { requireMention: true, disableAudioPreflight: true } },
      }) as never,
    );

    expect(preflight.resolve).not.toHaveBeenCalled();
    expect(runtime.dispatched).toHaveLength(0);
  });

  it('leaves groups without requireMention to the normal pipeline', async () => {
    await dispatchUpdate(
      inGroup({ text: '', attachments: [VOICE] }),
      makeOpts(PATTERNS, { groups: { '-7007': { requireMention: false } } }) as never,
    );

    expect(preflight.resolve).not.toHaveBeenCalled();
    expect(runtime.dispatched).toHaveLength(1);
    expect(runtime.dispatched[0].media).toEqual([
      expect.not.objectContaining({ transcribed: true }),
    ]);
  });
});

describe('group sender allowlist (groups.<id>.allowFrom / groupAllowFrom)', () => {
  let runtime: ReturnType<typeof makeRuntime>;
  const IMAGE = { type: 'image', payload: { url: 'https://files.example.test/p.jpg' } };
  const mentioned = (sender = MEMBER) => inGroup({ text: '@test_bot привет' }, sender);

  beforeEach(() => {
    runtime = makeRuntime();
    setMaxRuntime(runtime.core as never);
  });

  it('keeps the old behaviour without sender lists: any member of an admitted group', async () => {
    await dispatchUpdate(mentioned(OUTSIDER), makeOpts() as never);
    expect(runtime.dispatched).toHaveLength(1);
  });

  it('admits only listed senders and downloads nothing for the others', async () => {
    const opts = makeOpts(PATTERNS, { groupAllowFrom: ['max:1001'] });
    await dispatchUpdate(
      inGroup({ text: '@test_bot смотри', attachments: [IMAGE] }, OUTSIDER),
      opts as never,
    );
    await dispatchUpdate(inGroup({ text: '/status @test_bot' }, OUTSIDER), opts as never);
    expect(runtime.dispatched).toHaveLength(0);
    expect(runtime.fetchRemoteMedia).not.toHaveBeenCalled();

    await dispatchUpdate(mentioned(MEMBER), opts as never);
    expect(runtime.dispatched).toHaveLength(1);
    expect(runtime.dispatched[0].SenderId).toBe('1001');
  });

  it('admits anyone with "*"', async () => {
    await dispatchUpdate(
      mentioned(OUTSIDER),
      makeOpts(PATTERNS, { groupAllowFrom: ['*'] }) as never,
    );
    expect(runtime.dispatched).toHaveLength(1);
  });

  it("prefers the group's own list; an empty one falls back to groupAllowFrom", async () => {
    const own = makeOpts(PATTERNS, {
      groupAllowFrom: [1001],
      groups: { '-7007': { requireMention: true, allowFrom: [3003] } },
    });
    await dispatchUpdate(mentioned(MEMBER), own as never);
    await dispatchUpdate(mentioned(OUTSIDER), own as never);
    expect(runtime.dispatched.map((ctx) => ctx.SenderId)).toEqual(['3003']);

    const empty = makeOpts(PATTERNS, {
      groupAllowFrom: ['1001'],
      groups: { '-7007': { requireMention: true, allowFrom: [] } },
    });
    await dispatchUpdate(mentioned(OUTSIDER), empty as never);
    expect(runtime.dispatched).toHaveLength(1);
  });

  it('applies to button presses', async () => {
    const press = (user: typeof MEMBER) =>
      ({
        update_type: 'message_callback',
        timestamp: 1790000000000,
        callback: {
          callback_id: `cb.${user.user_id}`,
          payload: 'yes',
          user,
          timestamp: 1790000000000,
        },
        message: {
          sender: { user_id: 9009, is_bot: true },
          recipient: GROUP,
          timestamp: 1,
          body: { mid: 'mid.k' },
        },
      }) as unknown as MaxUpdate;
    const opts = makeOpts(PATTERNS, { groupAllowFrom: ['1001'] });
    await dispatchUpdate(press(OUTSIDER), opts as never);
    await dispatchUpdate(press(MEMBER), opts as never);
    expect(runtime.dispatched.map((ctx) => ctx.SenderId)).toEqual(['1001']);
  });
});
