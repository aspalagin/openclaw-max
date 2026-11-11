/**
 * Recovery of a message_created that MAX delivered without a message (seen for
 * large files: only update_type, timestamp and user_locale). The message is
 * looked up by the update's timestamp in the most recently active registered
 * dialogs and deduped under its real mid. The MAX API and the core runtime
 * are mocked; the update journal is real, in a temp dir. All ids, names and
 * URLs are synthetic.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MaxUpdate } from './api.js';
import { dispatchUpdate } from './dispatch.js';
import { setMaxRuntime } from './runtime.js';
import { openMaxUpdateJournal, resetMaxUpdateJournalsForTest } from './update-journal.js';
import { maxUpdateDedupeKey } from './webhook.js';

const BOT_USER_ID = 900001;
const USER_ID = 100001;
const CHAT_ID = 500001;
const TS = 1_700_000_000_000;
const MID = 'mid.test-recovered-file';
const SIGNED_URL = 'https://files.example.test/getfile?expires=1700003600&sig=SIGNED-SECRET';
const TOKEN = 'test-token-SECRET';

const user = { user_id: USER_ID, first_name: 'Test', is_bot: false, name: 'Test' };
const recipient = { chat_type: 'dialog', chat_id: CHAT_ID, user_id: BOT_USER_ID };

/** The user's message as GET /messages returns it. */
const directSend = {
  recipient,
  timestamp: TS,
  body: {
    mid: MID,
    seq: 2,
    text: '',
    attachments: [
      {
        payload: { url: SIGNED_URL, token: 'FILE-TOKEN', fileId: 1 },
        filename: 'recording.m4a',
        size: 73_400_320,
        type: 'file',
      },
    ],
  },
  sender: user,
};
/** A bot reply with the same timestamp must never be taken. */
const botReply = {
  recipient,
  timestamp: TS,
  body: { mid: 'mid.test-bot-reply', text: 'OK' },
  sender: { user_id: BOT_USER_ID, first_name: 'Bot', is_bot: true },
};
const older = {
  ...directSend,
  timestamp: TS - 60_000,
  body: { mid: 'mid.test-older', text: 'hi' },
};

/** What MAX delivers: no message, no chat. */
const bodyless = { update_type: 'message_created', timestamp: TS, user_locale: 'ru' } as MaxUpdate;

const EXPECTED_NOTE = '[file: recording.m4a, 70.0 MB — не загружен: превышает лимит 20 MB]';

type Entry = {
  chatId: number;
  type?: string;
  addedAt?: number;
  lastInboundAt?: number;
  removedAt?: number;
};

/** Registry with the MaxStateStore surface the inbound path uses, nothing written to disk. */
function fakeState(entries: Entry[] = []) {
  const chats: Record<string, Entry> = {};
  for (const entry of entries) chats[String(entry.chatId)] = entry;
  return {
    chats,
    upsertChat: vi.fn((chatId: number, patch: Partial<Entry>) => {
      chats[String(chatId)] = { ...chats[String(chatId)], ...patch, chatId };
    }),
    hasActiveChat: (chatId: number) =>
      Boolean(chats[String(chatId)]) && chats[String(chatId)].removedAt == null,
  };
}

let dispatchReply: ReturnType<typeof vi.fn>;
let log: Record<'debug' | 'info' | 'warn' | 'error', ReturnType<typeof vi.fn>>;
let api: Record<string, ReturnType<typeof vi.fn>>;
let tmpDir: string | undefined;

function options(extra: Record<string, unknown> = {}) {
  return {
    api,
    account: {
      accountId: 'default',
      enabled: true,
      token: TOKEN,
      tokenSource: 'config',
      config: { dmPolicy: 'allowlist', allowFrom: [String(USER_ID)], transport: 'webhook' },
    },
    config: {},
    abortSignal: new AbortController().signal,
    botUserId: BOT_USER_ID,
    log,
    statusSink: vi.fn(),
    ...extra,
  } as never;
}

function logged(level: keyof typeof log): string {
  return log[level].mock.calls.map((call) => call.join(' ')).join('\n');
}

function allLogText(): string {
  return (['debug', 'info', 'warn', 'error'] as const).map(logged).join('\n');
}

async function tempJournal() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'max-recover-test-'));
  return openMaxUpdateJournal({ accountId: 'default', dir: tmpDir });
}

beforeEach(() => {
  dispatchReply = vi.fn(async () => undefined);
  log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  api = {
    getMessages: vi.fn(async (chatId: number) =>
      chatId === CHAT_ID ? { messages: [botReply, directSend, older] } : { messages: [older] },
    ),
    getMessageById: vi.fn(),
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
        upsertPairingRequest: vi.fn(async () => ({ code: 'X', created: false })),
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
      media: { fetchRemoteMedia: vi.fn(), saveMediaBuffer: vi.fn() },
    },
  } as never);
});

afterEach(async () => {
  vi.useRealTimers();
  resetMaxUpdateJournalsForTest();
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe('message_created without a message: recovered by timestamp', () => {
  it('finds the user message with the exact timestamp in the most recent dialog and handles it', async () => {
    const state = fakeState([
      { chatId: 111, type: 'dialog', lastInboundAt: TS - 3_600_000 },
      { chatId: CHAT_ID, type: 'dialog', lastInboundAt: TS - 120_000 },
    ]);
    await dispatchUpdate(bodyless, options({ state }));

    expect(api.getMessages).toHaveBeenCalledTimes(1);
    expect(api.getMessages).toHaveBeenCalledWith(CHAT_ID, { count: 10 });
    expect(dispatchReply).toHaveBeenCalledTimes(1);
    const ctx = dispatchReply.mock.calls[0][0].ctx;
    expect(ctx.MessageSid).toBe(MID);
    expect(ctx.BodyForAgent).toContain(EXPECTED_NOTE);
    expect(logged('info')).toContain(`recovered by timestamp: ${MID} in chat ${CHAT_ID}`);
    expect(logged('warn')).not.toContain('dropped');
    expect(allLogText()).not.toContain('SECRET');
  });

  it('dedupes under the real mid: a redelivery or the full update is not handled again', async () => {
    const journal = await tempJournal();
    const state = fakeState([{ chatId: CHAT_ID, type: 'dialog', lastInboundAt: TS - 1000 }]);
    const realKey = `message_created:${TS}:${MID}`;

    await dispatchUpdate(bodyless, options({ state, journal }));
    expect(dispatchReply).toHaveBeenCalledTimes(1);
    expect(journal.hasCompleted(realKey)).toBe(true);
    // The full update MAX might still send is refused at admission.
    const fullUpdate = { ...bodyless, message: directSend } as MaxUpdate;
    expect(journal.isDuplicate(maxUpdateDedupeKey(fullUpdate)!)).toBe(true);

    // The same bodyless update dispatched again (e.g. recovered after a restart).
    await dispatchUpdate(bodyless, options({ state, journal }));
    expect(dispatchReply).toHaveBeenCalledTimes(1);
    expect(logged('info')).toContain(`MAX message ${MID} already handled, recovered copy skipped`);
  });

  it('skips the recovered copy when the full update was handled first', async () => {
    const journal = await tempJournal();
    await journal.remember(maxUpdateDedupeKey({ ...bodyless, message: directSend } as MaxUpdate)!);
    const state = fakeState([{ chatId: CHAT_ID, type: 'dialog', lastInboundAt: TS - 1000 }]);

    await dispatchUpdate(bodyless, options({ state, journal }));
    expect(dispatchReply).not.toHaveBeenCalled();
  });

  it('looks in at most 3 dialogs, most recent first; groups and removed dialogs excluded; warns on a miss', async () => {
    const state = fakeState([
      { chatId: 1, type: 'dialog', lastInboundAt: TS - 5000 },
      { chatId: 2, type: 'dialog', lastInboundAt: TS - 1000 },
      { chatId: 3, type: 'dialog', addedAt: TS - 9000 },
      { chatId: 4, type: 'dialog', lastInboundAt: TS - 3000 },
      { chatId: 5, type: 'dialog', lastInboundAt: TS - 10, removedAt: TS - 5 },
      { chatId: -6, type: 'chat', addedAt: TS },
    ]);
    await dispatchUpdate(bodyless, options({ state }));

    expect(api.getMessages.mock.calls.map((call) => call[0])).toEqual([2, 4, 1]);
    expect(dispatchReply).not.toHaveBeenCalled();
    expect(logged('warn')).toContain(
      `MAX message_created without a message dropped: no message with timestamp ${TS} in 3 dialog(s) (update fields: timestamp,update_type,user_locale)`,
    );
  });

  it('an API failure and the 10 s budget end the lookup with a warning', async () => {
    vi.useFakeTimers();
    api.getMessages.mockImplementationOnce(async () => {
      throw new Error('MAX API error 500');
    });
    api.getMessages.mockImplementationOnce(() => new Promise(() => undefined));
    const state = fakeState([
      { chatId: 1, type: 'dialog', lastInboundAt: 3 },
      { chatId: 2, type: 'dialog', lastInboundAt: 2 },
      { chatId: 3, type: 'dialog', lastInboundAt: 1 },
    ]);
    const done = dispatchUpdate(bodyless, options({ state }));
    await vi.advanceTimersByTimeAsync(10_000);
    await done;

    expect(api.getMessages).toHaveBeenCalledTimes(2);
    expect(dispatchReply).not.toHaveBeenCalled();
    const warn = logged('warn');
    expect(warn).toContain('chat 1: Error: MAX API error 500');
    expect(warn).toContain('chat 2: Error: timeout after 10000 ms');
    expect(warn).toContain('chat 3: lookup time budget spent');
    expect(allLogText()).not.toContain('SECRET');
  });

  it('without a registered dialog: warning, no requests', async () => {
    await dispatchUpdate(bodyless, options({ state: fakeState() }));

    expect(api.getMessages).not.toHaveBeenCalled();
    expect(logged('warn')).toContain(
      'MAX message_created without a message dropped: no registered dialog to look it up in (update fields: timestamp,update_type,user_locale)',
    );
  });
});

describe('dialog registry for the lookup', () => {
  it('an admitted DM registers its dialog (persisted, at most one write a minute)', async () => {
    const state = fakeState();
    const text = (mid: string) => ({
      recipient,
      timestamp: TS,
      body: { mid, text: 'hello' },
      sender: user,
    });
    await dispatchUpdate(
      { update_type: 'message_created', timestamp: TS, message: text('mid.test-a') } as MaxUpdate,
      options({ state }),
    );
    await dispatchUpdate(
      { update_type: 'message_created', timestamp: TS, message: text('mid.test-b') } as MaxUpdate,
      options({ state }),
    );

    expect(state.upsertChat).toHaveBeenCalledTimes(1);
    expect(state.upsertChat).toHaveBeenCalledWith(
      CHAT_ID,
      expect.objectContaining({ type: 'dialog', lastInboundAt: expect.any(Number) }),
    );
    expect(state.chats[String(CHAT_ID)].addedAt).toEqual(expect.any(Number));
  });

  it('a DM of a sender outside allowFrom does not register its dialog', async () => {
    const state = fakeState();
    await dispatchUpdate(
      {
        update_type: 'message_created',
        timestamp: TS,
        message: {
          recipient: { chat_type: 'dialog', chat_id: 500002, user_id: BOT_USER_ID },
          timestamp: TS,
          body: { mid: 'mid.test-stranger', text: 'hi' },
          sender: { user_id: 100003, first_name: 'Stranger', is_bot: false },
        },
      } as MaxUpdate,
      options({ state }),
    );

    expect(state.upsertChat).not.toHaveBeenCalled();
    expect(dispatchReply).not.toHaveBeenCalled();
  });
});
