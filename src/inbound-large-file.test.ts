/**
 * Inbound file over mediaMaxMb and incomplete webhook messages: a file MAX
 * declares too large is not downloaded and the agent gets a size note without
 * the signed URL; a dialog message delivered without the forwarded
 * attachments or without a sender is read back by its mid. The core media
 * fetcher is mocked and refuses anything over maxBytes the way core's
 * readRemoteMediaBuffer does (MediaFetchError code "max_bytes", message
 * carrying the source URL). All ids, names and URLs are synthetic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchUpdate } from './dispatch.js';
import { setMaxRuntime } from './runtime.js';

const SIGNED_URL = 'https://files.example.test/getfile?expires=1700003600&sig=SIGNED-SECRET';
const FILE_SIZE = 73_400_320; // 70.0 MB
const BOT_USER_ID = 900001;
const USER_ID = 100001;
const TS_DIRECT = 1_700_000_100_000;
const TS_FORWARD = 1_700_000_000_000;
const MID_DIRECT = 'mid.test-direct-file';
const MID_FORWARD = 'mid.test-forward-file';

const sender = { user_id: USER_ID, first_name: 'Test', is_bot: false, last_name: '', name: 'Test' };
const recipient = { chat_type: 'dialog', chat_id: 500001, user_id: BOT_USER_ID };

function fileAttachment(overrides: Record<string, unknown> = {}) {
  return {
    payload: { url: SIGNED_URL, token: 'FILE-TOKEN', fileId: 1 },
    filename: 'recording.m4a',
    size: FILE_SIZE,
    type: 'file',
    ...overrides,
  };
}

/** A direct send as GET /messages returns it. */
function directMessage(attachment: unknown = fileAttachment()) {
  return {
    recipient,
    timestamp: TS_DIRECT,
    body: { mid: MID_DIRECT, seq: 2, text: '', attachments: [attachment] },
    sender,
  };
}

/** A forward as GET /messages returns it; null drops the forwarded attachments. */
function forwardMessage(forwardedAttachments: unknown[] | null = [fileAttachment()]) {
  return {
    recipient,
    timestamp: TS_FORWARD,
    body: { mid: MID_FORWARD, seq: 1, text: '' },
    sender,
    link: {
      type: 'forward',
      message: {
        mid: 'mid.test-forward-origin',
        seq: 0,
        text: '',
        ...(forwardedAttachments ? { attachments: forwardedAttachments } : {}),
      },
      sender: {
        user_id: 100002,
        first_name: 'Author',
        is_bot: false,
        last_name: '',
        name: 'Author',
      },
      chat_id: 0,
    },
  };
}

function created(message: unknown, timestamp = TS_DIRECT) {
  return { update_type: 'message_created', timestamp, message, user_locale: 'ru' };
}

let dispatchReply: ReturnType<typeof vi.fn>;
let fetchRemoteMedia: ReturnType<typeof vi.fn>;
let saveMediaBuffer: ReturnType<typeof vi.fn>;
let log: Record<'debug' | 'info' | 'warn' | 'error', ReturnType<typeof vi.fn>>;
let api: Record<string, ReturnType<typeof vi.fn>>;

function options(config: Record<string, unknown> = {}) {
  return {
    api,
    account: {
      accountId: 'default',
      enabled: true,
      token: 'test-token',
      tokenSource: 'config',
      config: {
        dmPolicy: 'allowlist',
        allowFrom: [String(USER_ID)],
        transport: 'webhook',
        ...config,
      },
    },
    config: {},
    abortSignal: new AbortController().signal,
    botUserId: BOT_USER_ID,
    log,
    statusSink: vi.fn(),
  } as never;
}

function logged(level: keyof typeof log): string {
  return log[level].mock.calls.map((call) => call.join(' ')).join('\n');
}

function allLogText(): string {
  return (['debug', 'info', 'warn', 'error'] as const).map(logged).join('\n');
}

function agentBody(): string {
  expect(dispatchReply).toHaveBeenCalledTimes(1);
  return dispatchReply.mock.calls[0][0].ctx.BodyForAgent as string;
}

beforeEach(() => {
  dispatchReply = vi.fn(async () => undefined);
  fetchRemoteMedia = vi.fn(async ({ url, maxBytes }: { url: string; maxBytes: number }) => {
    const err = new Error(
      `Failed to fetch media from ${url}: content length ${FILE_SIZE} exceeds maxBytes ${maxBytes}`,
    ) as Error & { code: string };
    err.name = 'MediaFetchError';
    err.code = 'max_bytes';
    throw err;
  });
  saveMediaBuffer = vi.fn(async () => ({
    path: '/tmp/openclaw-test-media/recording.m4a',
    contentType: 'audio/mp4',
  }));
  log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  api = {
    getMessageById: vi.fn(async () => forwardMessage()),
    sendAction: vi.fn(async () => ({ success: true })),
    getVideoInfo: vi.fn(),
    answerCallback: vi.fn(),
  };
  setMaxRuntime({
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          agentId: 'main',
          accountId: 'default',
          sessionKey: `agent:main:max:direct:${USER_ID}`,
        }),
      },
      pairing: {
        readAllowFromStore: async () => [],
        upsertPairingRequest: vi.fn(),
        buildPairingReply: vi.fn(),
      },
      session: {
        resolveStorePath: () => '/tmp/openclaw-test-sessions',
        readSessionUpdatedAt: () => undefined,
        recordSessionMetaFromInbound: async () => undefined,
      },
      reply: {
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        finalizeInboundContext: (ctx: unknown) => ctx,
        dispatchReplyWithBufferedBlockDispatcher: dispatchReply,
      },
      media: { fetchRemoteMedia, saveMediaBuffer },
    },
  } as never);
});

const EXPECTED = '[file: recording.m4a, 70.0 MB — не загружен: превышает лимит 20 MB]';

describe('inbound file over mediaMaxMb', () => {
  it('direct send: the turn happens with a size note, no download, no signed URL', async () => {
    await dispatchUpdate(created(directMessage()) as never, options());

    expect(agentBody()).toContain(EXPECTED);
    expect(agentBody()).not.toContain('SIGNED-SECRET');
    expect(fetchRemoteMedia).not.toHaveBeenCalled();
    expect(logged('warn')).toContain(
      `file of ${MID_DIRECT} not loaded: ${FILE_SIZE} bytes, over the mediaMaxMb limit of 20 MB`,
    );
    expect(allLogText()).not.toContain('SIGNED-SECRET');
  });

  it('forward: the size note stays inside the forwarded block', async () => {
    await dispatchUpdate(created(forwardMessage(), TS_FORWARD) as never, options());

    const body = agentBody();
    expect(body).toContain('[Forwarded message from Author]');
    expect(body).toContain(EXPECTED);
    expect(body).not.toContain('SIGNED-SECRET');
    expect(fetchRemoteMedia).not.toHaveBeenCalled();
    expect(api.getMessageById).not.toHaveBeenCalled();
  });

  it('download refused without a declared size: note and error log without the URL', async () => {
    const withoutSize: Record<string, unknown> = fileAttachment();
    delete withoutSize.size;
    await dispatchUpdate(created(directMessage(withoutSize)) as never, options());

    expect(fetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(agentBody()).toContain('[file: recording.m4a — не загружен: превышает лимит 20 MB]');
    expect(agentBody()).not.toContain('SIGNED-SECRET');
    expect(logged('error')).toContain(`Failed to download file of ${MID_DIRECT}`);
    expect(logged('error')).toContain('<url>');
    expect(allLogText()).not.toContain('SIGNED-SECRET');
  });

  it('another download failure: "ошибка загрузки" note without the URL', async () => {
    fetchRemoteMedia.mockRejectedValueOnce(new Error(`HTTP 403 from ${SIGNED_URL}`));
    await dispatchUpdate(
      created(directMessage(fileAttachment({ size: 5 * 1024 * 1024 }))) as never,
      options(),
    );

    expect(agentBody()).toContain('[file: recording.m4a, 5.0 MB — не загружен: ошибка загрузки]');
    expect(agentBody()).not.toContain('SIGNED-SECRET');
    expect(allLogText()).not.toContain('SIGNED-SECRET');
  });

  it('mediaMaxMb 200: the file is downloaded and handed over as media', async () => {
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from('m4a'),
      contentType: 'audio/mp4',
      fileName: 'recording.m4a',
    });
    await dispatchUpdate(created(directMessage()) as never, options({ mediaMaxMb: 200 }));

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ maxBytes: 200 * 1024 * 1024 }),
    );
    expect(dispatchReply).toHaveBeenCalledTimes(1);
    const ctx = dispatchReply.mock.calls[0][0].ctx;
    expect(ctx.media).toHaveLength(1);
    expect(ctx.media[0].path).toBe('/tmp/openclaw-test-media/recording.m4a');
  });
});

describe('incomplete webhook messages', () => {
  it('a forward without the forwarded attachments is refetched by mid, not dropped', async () => {
    await dispatchUpdate(created(forwardMessage(null), TS_FORWARD) as never, options());

    expect(api.getMessageById).toHaveBeenCalledWith(MID_FORWARD);
    expect(agentBody()).toContain(EXPECTED);
    expect(logged('info')).toContain(
      `MAX message ${MID_FORWARD} arrived incomplete, refetched by mid`,
    );
  });

  it('a message without a sender is refetched by mid', async () => {
    await dispatchUpdate(
      created({ ...forwardMessage(), sender: undefined }, TS_FORWARD) as never,
      options(),
    );

    expect(api.getMessageById).toHaveBeenCalledWith(MID_FORWARD);
    expect(agentBody()).toContain(EXPECTED);
  });

  it('a failed refetch keeps the delivered message and is logged', async () => {
    api.getMessageById.mockRejectedValueOnce(new Error('MAX API error 500'));
    await dispatchUpdate(created(forwardMessage(null), TS_FORWARD) as never, options());

    expect(dispatchReply).not.toHaveBeenCalled();
    expect(logged('warn')).toContain(
      `MAX message ${MID_FORWARD} arrived incomplete, refetch failed: Error: MAX API error 500`,
    );
    expect(logged('info')).toContain(
      `Skipping empty message ${MID_FORWARD}: no text, attachments or forwarded content`,
    );
  });

  it('an empty message without a mid is skipped visibly, nothing refetched', async () => {
    await dispatchUpdate(
      created({ ...directMessage(), body: { mid: '', text: '' } }) as never,
      options(),
    );

    expect(dispatchReply).not.toHaveBeenCalled();
    expect(api.getMessageById).not.toHaveBeenCalled();
    expect(logged('info')).toContain('Skipping empty message');
  });

  it('message_created without a message is dropped visibly when no dialog is known', async () => {
    await dispatchUpdate(
      { update_type: 'message_created', timestamp: TS_DIRECT, user_locale: 'ru' } as never,
      options(),
    );

    expect(dispatchReply).not.toHaveBeenCalled();
    expect(logged('warn')).toContain(
      'MAX message_created without a message dropped: no registered dialog to look it up in (update fields: timestamp,update_type,user_locale)',
    );
  });
});
