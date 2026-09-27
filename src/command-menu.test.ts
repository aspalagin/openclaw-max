/**
 * Tests for core command argument menus: a bare /think, /fast, … opens its
 * choices as buttons, a press re-enters as the command text, and presses are
 * checked for command rights, DM/group policy and stale choices.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MaxUpdate } from './api.js';
import { decodeMaxCommandMenuPayload, encodeMaxCommandMenuPayload } from './command-menu.js';
import { deliverMaxReply } from './deliver.js';
import { dispatchUpdate } from './dispatch.js';
import { setMaxRuntime } from './runtime.js';

vi.mock('./deliver.js', () => ({ deliverMaxReply: vi.fn(async () => undefined) }));

const OWNER = { user_id: 1001, first_name: 'Anna', is_bot: false };
const GUEST = { user_id: 2002, first_name: 'Ivan', is_bot: false };
const DIALOG = { chat_id: 5005, chat_type: 'dialog' };
const GROUP = { chat_id: -7007, chat_type: 'chat' };

type Buttons = Array<Array<{ text: string; payload: string }>>;

function makeRuntime(sessionEntry: Record<string, unknown> | undefined = undefined) {
  const dispatched: Record<string, unknown>[] = [];
  const shouldHandleTextCommands = vi.fn(() => true);
  const getSessionEntry = vi.fn(() => sessionEntry);
  const core = {
    agent: { session: { getSessionEntry } },
    modelConfig: {
      resolveDefaultModelForAgent: vi.fn(() => ({
        provider: 'anthropic',
        model: 'claude-opus-5-5',
      })),
    },
    channel: {
      commands: { shouldHandleTextCommands },
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
  return { core, dispatched, shouldHandleTextCommands, getSessionEntry };
}

function makeOpts(accountConfig: Record<string, unknown> = {}) {
  return {
    api: {
      sendAction: vi.fn(async () => ({ success: true })),
      answerCallback: vi.fn(async () => ({ success: true })),
    },
    account: {
      accountId: 'default',
      enabled: true,
      token: 'test-token',
      tokenSource: 'config' as const,
      config: {
        dmPolicy: 'allowlist',
        allowFrom: ['1001', '2002'],
        markSeen: false,
        groupPolicy: 'allowlist',
        groups: { '-7007': { requireMention: true } },
        ...accountConfig,
      },
    },
    // Only the owner may run commands; both senders pass the DM allowlist.
    config: { channels: {}, commands: { allowFrom: { max: ['1001'] } } },
    abortSignal: new AbortController().signal,
    botUserId: 9009,
    botUsername: 'test_bot',
  };
}

function typed(text: string, sender = OWNER, recipient = DIALOG): MaxUpdate {
  return {
    update_type: 'message_created',
    timestamp: 1790000000000,
    message: { sender, recipient, timestamp: 1790000000000, body: { mid: 'mid.1', seq: 1, text } },
  } as unknown as MaxUpdate;
}

function pressed(payload: string, sender = OWNER, recipient = DIALOG): MaxUpdate {
  return {
    update_type: 'message_callback',
    timestamp: 1790000000500,
    callback: { callback_id: 'cb.1', payload, user: sender, timestamp: 1790000000500 },
    message: {
      sender: { user_id: 9009, is_bot: true },
      recipient,
      timestamp: 1790000000000,
      body: { mid: 'mid.menu', seq: 2, text: 'Choose level for /think.' },
    },
  } as unknown as MaxUpdate;
}

function lastMenu(): { text: string; buttons: Buttons; callbackId?: string; replyToId?: string } {
  const call = vi.mocked(deliverMaxReply).mock.calls.at(-1)?.[0] as unknown as {
    payload: { text: string; channelData: { max: { buttons: Buttons } } };
    callbackId?: string;
    replyToId?: string;
  };
  return {
    text: call.payload.text,
    buttons: call.payload.channelData.max.buttons,
    callbackId: call.callbackId,
    replyToId: call.replyToId,
  };
}

describe('command menu payloads', () => {
  it('round-trips the command text and ignores other payloads', () => {
    const payload = encodeMaxCommandMenuPayload('/think high');
    expect(payload).toBe('mxcmd1:/think high');
    expect(decodeMaxCommandMenuPayload(payload)).toBe('/think high');
    expect(decodeMaxCommandMenuPayload('/think high')).toBeNull();
    expect(decodeMaxCommandMenuPayload('mxcb1:x')).toBeNull();
    expect(decodeMaxCommandMenuPayload('mxcmd1:not a command')).toBeNull();
    expect(encodeMaxCommandMenuPayload(`/think ${'x'.repeat(1100)}`)).toBeNull();
  });
});

describe('command argument menus', () => {
  let runtime: ReturnType<typeof makeRuntime>;

  beforeEach(() => {
    vi.mocked(deliverMaxReply).mockClear();
    runtime = makeRuntime();
    setMaxRuntime(runtime.core as never);
  });

  it('opens core choices for a bare /think instead of dispatching it', async () => {
    await dispatchUpdate(typed('/think'), makeOpts() as never);

    expect(runtime.dispatched).toHaveLength(0);
    const menu = lastMenu();
    expect(menu.text).toContain('Choose level for /think.');
    expect(menu.replyToId).toBe('mid.1');
    expect(menu.callbackId).toBeUndefined();
    const flat = menu.buttons.flat();
    expect(flat.map((button) => button.payload)).toContain('mxcmd1:/think high');
    // Nothing stored for the session: the "default" choice is current.
    expect(flat.find((button) => button.payload === 'mxcmd1:/think default')?.text).toBe(
      'default ✓',
    );
    expect(menu.buttons.every((row) => row.length <= 2)).toBe(true);
    expect(runtime.getSessionEntry).toHaveBeenCalledWith({
      agentId: 'main',
      sessionKey: 'agent:main:max:direct:1001',
    });
  });

  it('marks the session level and names it in the title', async () => {
    runtime = makeRuntime({ thinkingLevel: 'high' });
    setMaxRuntime(runtime.core as never);

    await dispatchUpdate(typed('/thinking'), makeOpts() as never);

    const menu = lastMenu();
    expect(menu.text.startsWith('Current thinking level: high.')).toBe(true);
    const labels = menu.buttons.flat().map((button) => button.text);
    expect(labels).toContain('high ✓');
    expect(labels).toContain('default');
  });

  it('shows the core fast-mode status over the /fast choices', async () => {
    await dispatchUpdate(typed('/fast'), makeOpts() as never);

    const menu = lastMenu();
    expect(menu.text).toContain('Current fast mode: off');
    expect(menu.buttons.flat().map((button) => button.payload)).toEqual(
      expect.arrayContaining(['mxcmd1:/fast on', 'mxcmd1:/fast off']),
    );
  });

  it('sends a command with its argument to core as typed', async () => {
    await dispatchUpdate(typed('/think high'), makeOpts() as never);

    expect(deliverMaxReply).not.toHaveBeenCalled();
    expect(runtime.dispatched).toHaveLength(1);
    expect(runtime.dispatched[0].CommandBody).toBe('/think high');
  });

  it('leaves a sender without command rights to core (no menu)', async () => {
    await dispatchUpdate(typed('/think', GUEST), makeOpts() as never);

    expect(deliverMaxReply).not.toHaveBeenCalled();
    expect(runtime.dispatched).toHaveLength(1);
  });

  it('leaves commands to core when text commands are off for MAX', async () => {
    runtime.shouldHandleTextCommands.mockReturnValue(false);

    await dispatchUpdate(typed('/think'), makeOpts() as never);

    expect(deliverMaxReply).not.toHaveBeenCalled();
    expect(runtime.dispatched).toHaveLength(1);
  });

  it('applies a pressed choice exactly like the typed command', async () => {
    const opts = makeOpts();
    await dispatchUpdate(pressed('mxcmd1:/think high'), opts as never);

    expect(deliverMaxReply).not.toHaveBeenCalled();
    expect(opts.api.answerCallback).not.toHaveBeenCalled();
    expect(runtime.dispatched).toHaveLength(1);
    const ctx = runtime.dispatched[0];
    expect(ctx.CommandBody).toBe('/think high');
    expect(ctx.CommandSource).toBe('text');
    expect(ctx.SenderId).toBe('1001');
  });

  it('refuses a press by a sender without command rights', async () => {
    const opts = makeOpts();
    await dispatchUpdate(pressed('mxcmd1:/think high', GUEST), opts as never);

    expect(runtime.dispatched).toHaveLength(0);
    expect(opts.api.answerCallback).toHaveBeenCalledWith('cb.1', {
      notification: 'You are not allowed to use this command.',
    });
  });

  it('answers a stale press instead of applying it', async () => {
    const opts = makeOpts();
    await dispatchUpdate(pressed('mxcmd1:/think turbo'), opts as never);
    await dispatchUpdate(pressed('mxcmd1:/status'), opts as never);

    expect(runtime.dispatched).toHaveLength(0);
    expect(opts.api.answerCallback).toHaveBeenCalledTimes(2);
    expect(opts.api.answerCallback).toHaveBeenLastCalledWith('cb.1', {
      notification: 'This menu is out of date. Send the command again.',
    });
  });

  it('answers a press after text commands were turned off as stale', async () => {
    runtime.shouldHandleTextCommands.mockReturnValue(false);
    const opts = makeOpts();

    await dispatchUpdate(pressed('mxcmd1:/think high'), opts as never);

    expect(runtime.dispatched).toHaveLength(0);
    expect(opts.api.answerCallback).toHaveBeenCalledWith('cb.1', {
      notification: 'This menu is out of date. Send the command again.',
    });
  });

  it('keeps DM policy in front of presses', async () => {
    const opts = makeOpts({ allowFrom: ['2002'] });

    await dispatchUpdate(pressed('mxcmd1:/think high'), opts as never);

    expect(runtime.dispatched).toHaveLength(0);
    expect(opts.api.answerCallback).not.toHaveBeenCalled();
  });

  it('keeps group policy in front of presses and needs no mention in admitted groups', async () => {
    const blocked = makeOpts({ groups: {} });
    await dispatchUpdate(pressed('mxcmd1:/think high', OWNER, GROUP), blocked as never);
    expect(runtime.dispatched).toHaveLength(0);

    await dispatchUpdate(pressed('mxcmd1:/think high', OWNER, GROUP), makeOpts() as never);
    expect(runtime.dispatched).toHaveLength(1);
    expect(runtime.dispatched[0].ChatType).toBe('group');
  });

  it('replaces the pressed menu when a press opens the next menu', async () => {
    const opts = makeOpts();
    await dispatchUpdate(pressed('mxcmd1:/think'), opts as never);

    expect(runtime.dispatched).toHaveLength(0);
    expect(lastMenu().callbackId).toBe('cb.1');
  });
});
