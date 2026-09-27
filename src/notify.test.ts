/**
 * Tests for silent sends and notification / link-preview defaults: core's
 * `silent` flag, channelData.max and channels.max.notify / disableLinkPreview
 * on every send path; MAX channels always notify.
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveMaxAccount } from './accounts.js';
import { maxMessageActions } from './actions.js';
import { maxOutboundAdapter } from './channel-outbound.js';
import { MaxConfigSchema } from './config-schema.js';
import { deliverMaxReply } from './deliver.js';
import { setMaxRuntime } from './runtime.js';
import { resolveMaxSendFlags, sendMaxMessage } from './send.js';

type Call = { method: string; url: URL; body: Record<string, unknown> };

let calls: Call[];

/**
 * Fetch mock: GET /chats/{id} answers from `chats` (id → type, or an error
 * status), POST /messages answers with a sent message.
 */
function mockFetch(chats: Record<string, string | number> = {}) {
  calls = [];
  global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    calls.push({
      method: String(init?.method ?? 'GET'),
      url: parsed,
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    const chat = /^\/chats\/(-?\d+)$/.exec(parsed.pathname)?.[1];
    if (chat !== undefined) {
      const known = chats[chat];
      if (typeof known === 'number') {
        const code = known === 404 ? 'chat.not.found' : 'access.denied';
        return new Response(JSON.stringify({ code, message: code }), { status: known });
      }
      return new Response(JSON.stringify({ chat_id: Number(chat), type: known ?? 'chat' }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({ message: { body: { mid: 'mid.1' }, recipient: { chat_id: 1 } } }),
      { status: 200 },
    );
  }) as typeof fetch;
}

const posts = () => calls.filter((c) => c.method === 'POST' && c.url.pathname === '/messages');
const lookups = () => calls.filter((c) => c.method === 'GET');

function useConfig(max: Record<string, unknown>) {
  const cfg = { channels: { max: { botToken: 'test-token', ...max } } } as OpenClawConfig;
  setMaxRuntime({
    config: { current: () => cfg },
    channel: {
      text: {
        chunkMarkdownText: (text: string) => [text],
        resolveChunkMode: () => 'length',
        chunkMarkdownTextWithMode: (text: string) => [text],
      },
    },
  } as never);
  return cfg;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('resolveMaxSendFlags', () => {
  it('leaves MAX defaults when nothing is set', () => {
    expect(resolveMaxSendFlags({})).toEqual({});
  });

  it('applies account defaults', () => {
    expect(resolveMaxSendFlags({ notify: false, disableLinkPreview: true })).toEqual({
      notify: false,
      disableLinkPreview: true,
    });
  });

  it('an explicit value of the call beats the default', () => {
    expect(resolveMaxSendFlags({ notify: true }, { silent: true })).toEqual({ notify: false });
    expect(resolveMaxSendFlags({ notify: false }, { silent: false })).toEqual({ notify: true });
    expect(
      resolveMaxSendFlags(
        { notify: false, disableLinkPreview: true },
        { channelData: { max: { notify: true, disableLinkPreview: false } } },
      ),
    ).toEqual({ notify: true, disableLinkPreview: false });
    expect(resolveMaxSendFlags({}, { channelData: { max: { silent: true } } })).toEqual({
      notify: false,
    });
  });

  it('core silent beats channelData', () => {
    expect(
      resolveMaxSendFlags({}, { silent: true, channelData: { max: { notify: true } } }),
    ).toEqual({ notify: false });
  });
});

describe('config', () => {
  it('accepts notify and disableLinkPreview on the channel and accounts', () => {
    const parsed = MaxConfigSchema.safeParse({
      notify: false,
      disableLinkPreview: true,
      accounts: { work: { notify: true } },
    });
    expect(parsed.success).toBe(true);
    expect(MaxConfigSchema.safeParse({ notify: 'no' }).success).toBe(false);
  });

  it('named accounts inherit the channel-level defaults', () => {
    const cfg = {
      channels: {
        max: {
          notify: false,
          disableLinkPreview: true,
          accounts: { work: { botToken: 't' }, loud: { botToken: 't', notify: true } },
        },
      },
    } as unknown as OpenClawConfig;
    expect(resolveMaxAccount({ cfg }).config.notify).toBe(false);
    expect(resolveMaxAccount({ cfg, accountId: 'work' }).config).toMatchObject({
      notify: false,
      disableLinkPreview: true,
    });
    expect(resolveMaxAccount({ cfg, accountId: 'loud' }).config.notify).toBe(true);
  });
});

describe('MAX channels always notify', () => {
  it('drops notify=false for a channel (one cached lookup)', async () => {
    mockFetch({ '-7001': 'channel' });
    await sendMaxMessage('-7001', 'post', { token: 't', notify: false });
    await sendMaxMessage('-7001', 'post 2', { token: 't', notify: false });
    expect(lookups().map((c) => c.url.pathname)).toEqual(['/chats/-7001']);
    expect(posts().map((c) => c.body.notify)).toEqual([undefined, undefined]);
  });

  it('keeps notify=false for group chats and dialogs', async () => {
    mockFetch({ '-7002': 'chat', '7003': 'dialog' });
    await sendMaxMessage('-7002', 'hi', { token: 't', notify: false });
    await sendMaxMessage('7003', 'hi', { token: 't', notify: false });
    expect(posts().map((c) => c.body.notify)).toEqual([false, false]);
  });

  it('does not look up user targets or notifying sends', async () => {
    mockFetch();
    await sendMaxMessage('user:7004', 'hi', { token: 't', notify: false });
    await sendMaxMessage('-7005', 'hi', { token: 't' });
    expect(lookups()).toHaveLength(0);
    expect(posts()[0].body.notify).toBe(false);
  });

  it('keeps notify=false for an unknown chat id (the send retries as user_id)', async () => {
    mockFetch({ '7006': 404 });
    await sendMaxMessage('7006', 'hi', { token: 't', notify: false });
    expect(posts()[0].body.notify).toBe(false);
  });

  it('notifies when the chat type cannot be read (a failed post is worse)', async () => {
    mockFetch({ '-7007': 403 });
    await sendMaxMessage('-7007', 'hi', { token: 't', notify: false });
    expect(posts()[0].body.notify).toBeUndefined();
  });
});

describe('send paths', () => {
  it('outbound sendText: silent flag and account defaults', async () => {
    const cfg = useConfig({ notify: false, disableLinkPreview: true });
    mockFetch({ '-7101': 'chat' });
    const send = (silent?: boolean) =>
      maxOutboundAdapter.sendText!({ cfg, to: '-7101', text: 'x', silent } as never);
    await send();
    await send(false);
    await send(true);
    expect(posts().map((c) => c.body.notify)).toEqual([false, true, false]);
    expect(posts().map((c) => c.url.searchParams.get('disable_link_preview'))).toEqual([
      'true',
      'true',
      'true',
    ]);
  });

  it('outbound sendPayload and sendMedia honor silent', async () => {
    const cfg = useConfig({});
    mockFetch({ '-7102': 'chat' });
    await maxOutboundAdapter.sendPayload!({
      cfg,
      to: '-7102',
      text: 'x',
      payload: { text: 'x', channelData: { max: { disableLinkPreview: true } } },
      silent: true,
    } as never);
    await maxOutboundAdapter.sendMedia!({ cfg, to: '-7102', text: 'y', silent: true } as never);
    expect(posts().map((c) => c.body.notify)).toEqual([false, false]);
    expect(posts()[0].url.searchParams.get('disable_link_preview')).toBe('true');
  });

  it('message tool send and sendAttachment honor silent over the default', async () => {
    const cfg = useConfig({ notify: false });
    mockFetch({ '-7103': 'chat' });
    // An owner call (as the CLI makes it): actionScope is not under test here.
    const actions = {
      handleAction: (ctx: object) =>
        maxMessageActions.handleAction!({ senderIsOwner: true, ...ctx } as never),
    };
    await actions.handleAction({
      action: 'send',
      params: { target: '-7103', message: 'a' },
      cfg,
    });
    await actions.handleAction({
      action: 'send',
      params: { target: '-7103', message: 'b', silent: false },
      cfg,
    });
    await actions.handleAction({
      action: 'sendAttachment',
      params: { target: '-7103', latitude: 55.75, longitude: 37.62, silent: false },
      cfg,
    });
    expect(posts().map((c) => c.body.notify)).toEqual([false, true, true]);
  });

  it('agent replies apply the account default and channelData.max', async () => {
    const cfg = useConfig({});
    mockFetch({ '-7104': 'chat' });
    const account = resolveMaxAccount({
      cfg: {
        channels: { max: { botToken: 't', notify: false, disableLinkPreview: true } },
      } as OpenClawConfig,
    });
    const deliver = (channelData?: unknown) =>
      deliverMaxReply({
        payload: { text: 'reply', channelData },
        account,
        chatId: '-7104',
        config: cfg,
      });
    await deliver();
    await deliver({ max: { notify: true, disableLinkPreview: false } });
    expect(posts().map((c) => c.body.notify)).toEqual([false, true]);
    expect(posts().map((c) => c.url.searchParams.get('disable_link_preview'))).toEqual([
      'true',
      null,
    ]);
  });
});
