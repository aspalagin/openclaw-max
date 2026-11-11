/**
 * channels.max.actions gate what an action does on the way, not only the
 * action itself: with `pin: false` no path pins (send with pin=true or
 * delivery.pin, a presentation send, core's delivery pin, the pin of an agent
 * reply), and with `sticker: false` send does not send a sticker by
 * stickerId. Every turned-off action is refused before any MAX call.
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { maxMessageActions } from './actions.js';
import { maxOutboundAdapter } from './channel-outbound.js';
import { deliverMaxReply } from './deliver.js';
import { MAX_PIN_DISABLED } from './presentation.js';
import { setMaxRuntime } from './runtime.js';

const GROUP = '-7001';
const PRESENTATION = { blocks: [{ type: 'text', text: 'Deploy?' }] };

type Call = { method: string; url: string };
let calls: Call[];

/** MAX answers: a sent message in the group, success for everything else. */
function mockMax() {
  calls = [];
  global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ method: String(init?.method), url: String(url) });
    const json =
      init?.method === 'POST' && String(url).includes('/messages')
        ? {
            message: {
              body: { mid: 'mid.sent' },
              recipient: { chat_id: -7001, chat_type: 'chat' },
            },
          }
        : { success: true };
    return new Response(JSON.stringify(json), { status: 200 });
  }) as typeof fetch;
}

const sends = () => calls.filter((c) => c.method === 'POST' && c.url.includes('/messages'));
const pins = () => calls.filter((c) => c.method === 'PUT' && c.url.includes('/pin'));

function cfgWith(actions?: Record<string, unknown>): OpenClawConfig {
  return {
    channels: { max: { botToken: 'test-token', ...(actions ? { actions } : {}) } },
  } as unknown as OpenClawConfig;
}

function handle(action: string, params: Record<string, unknown>, cfg: OpenClawConfig) {
  return maxMessageActions.handleAction!({ action, params, cfg, senderIsOwner: true } as never);
}

function prepare(payload: Record<string, unknown>, cfg: OpenClawConfig) {
  return maxMessageActions.prepareSendPayload!({
    ctx: { action: 'send', cfg, params: {}, senderIsOwner: true } as never,
    to: GROUP,
    payload: payload as never,
  });
}

const LOG = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function deliverReply(delivery: unknown, actions?: Record<string, unknown>) {
  return deliverMaxReply({
    payload: { text: 'Готово', delivery },
    account: {
      accountId: 'default',
      enabled: true,
      token: 'test-token',
      tokenSource: 'config',
      config: actions ? { actions } : {},
    } as never,
    chatId: GROUP,
    config: { channels: {} },
    log: LOG,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMax();
  setMaxRuntime({
    channel: {
      text: {
        chunkMarkdownText: vi.fn((text: string) => [text]),
        resolveChunkMode: vi.fn(() => 'length'),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
      },
    },
  } as never);
});

describe('actions.pin: false gates every pin', () => {
  it('hides the pin actions and the delivery-pin capability from the message tool', () => {
    const off = maxMessageActions.describeMessageTool!({ cfg: cfgWith({ pin: false }) } as never);
    expect(off?.actions).not.toContain('pin');
    expect(off?.capabilities).toEqual(['presentation']);
    const on = maxMessageActions.describeMessageTool!({ cfg: cfgWith() } as never);
    expect(on?.capabilities).toEqual(['presentation', 'delivery-pin']);
  });

  it.each([
    ['pin=true', { pin: true }],
    ['delivery.pin', { delivery: { pin: true } }],
    ['a required delivery.pin', { delivery: { pin: { enabled: true, required: true } } }],
    ['a presentation with delivery.pin', { presentation: PRESENTATION, delivery: { pin: true } }],
  ])('send with %s is refused before anything is sent', async (_name, extra) => {
    await expect(
      handle('send', { target: GROUP, message: 'hi', ...extra }, cfgWith({ pin: false })),
    ).rejects.toThrow(MAX_PIN_DISABLED);
    expect(calls).toEqual([]);
  });

  it('send without a pin still goes', async () => {
    await handle('send', { target: GROUP, message: 'hi' }, cfgWith({ pin: false }));
    expect(sends()).toHaveLength(1);
    expect(pins()).toHaveLength(0);
  });

  it('with the pin action on, send with pin=true pins as before', async () => {
    const result = await handle('send', { target: GROUP, message: 'hi', pin: true }, cfgWith());
    expect(sends()).toHaveLength(1);
    expect(pins()).toHaveLength(1);
    expect(JSON.stringify(result)).toContain('"pinned":true');
  });

  it('a legacy policy string leaves the pin on, as it does for the pin action', async () => {
    await handle(
      'send',
      { target: GROUP, message: 'hi', pin: true },
      cfgWith({ pin: 'allowlist' }),
    );
    expect(pins()).toHaveLength(1);
  });

  it('a presentation send core delivers itself is refused in prepareSendPayload', async () => {
    await expect(
      prepare(
        { text: 'hi', presentation: PRESENTATION, delivery: { pin: true } },
        cfgWith({ pin: false }),
      ),
    ).rejects.toThrow(MAX_PIN_DISABLED);
    await expect(
      prepare({ text: 'hi', presentation: PRESENTATION }, cfgWith({ pin: false })),
    ).resolves.toMatchObject({ presentation: PRESENTATION });
    expect(calls).toEqual([]);
  });

  it("core's delivery pin is refused without a MAX call (core keeps the message and logs it)", async () => {
    const assertDirectAdapterHandoff = vi.fn();
    await expect(
      maxOutboundAdapter.pinDeliveredMessage!({
        cfg: cfgWith({ pin: false }),
        target: { channel: 'max', to: GROUP },
        messageId: 'mid.sent',
        pin: { enabled: true },
        assertDirectAdapterHandoff,
      } as never),
    ).rejects.toThrow(MAX_PIN_DISABLED);
    expect(calls).toEqual([]);
    expect(assertDirectAdapterHandoff).not.toHaveBeenCalled();
  });

  it('an agent reply with delivery.pin is delivered, the pin is skipped with a warning', async () => {
    await deliverReply({ pin: true }, { pin: false });
    expect(sends()).toHaveLength(1);
    expect(pins()).toHaveLength(0);
    expect(LOG.warn).toHaveBeenCalledWith(
      `[default] MAX pin of mid.sent skipped: ${MAX_PIN_DISABLED}`,
    );

    await deliverReply({ pin: { enabled: true, required: true } }, { pin: false });
    expect(pins()).toHaveLength(0);
    expect(LOG.error).toHaveBeenCalledWith(
      `[default] MAX pin of mid.sent skipped: ${MAX_PIN_DISABLED}`,
    );
  });

  it('an agent reply with delivery.pin pins while the pin action is on', async () => {
    await deliverReply({ pin: true });
    expect(pins()).toHaveLength(1);
  });
});

describe('actions.sticker: false', () => {
  it('send with stickerId is refused before anything is sent', async () => {
    await expect(
      handle(
        'send',
        { target: GROUP, message: '', stickerId: 'CODE' },
        cfgWith({ sticker: false }),
      ),
    ).rejects.toThrow('MAX action "sticker" is disabled by channels.max.actions');
    expect(calls).toEqual([]);
  });

  it('with the sticker action on, send with stickerId sends the sticker', async () => {
    await handle('send', { target: GROUP, message: '', stickerId: 'CODE' }, cfgWith());
    expect(sends()).toHaveLength(1);
  });
});

describe('every turned-off action is refused before any MAX call', () => {
  it.each([
    ['send', { target: GROUP, message: 'hi' }],
    ['sendAttachment', { target: GROUP, type: 'location', latitude: '55.75', longitude: '37.62' }],
    ['sticker', { target: GROUP, stickerId: 'CODE' }],
    ['edit', { messageId: 'mid.1', message: 'new' }],
    ['delete', { messageId: 'mid.1' }],
    ['pin', { target: GROUP, messageId: 'mid.1' }],
    ['unpin', { target: GROUP }],
  ])('%s', async (action, params) => {
    await expect(handle(action, params, cfgWith({ [action]: false }))).rejects.toThrow(
      `MAX action "${action}" is disabled by channels.max.actions`,
    );
    expect(calls).toEqual([]);
  });
});
