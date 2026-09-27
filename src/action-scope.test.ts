/**
 * Tests for message-tool action scoping (channels.max.actionScope): each
 * mutating action runs in the current chat, on an owner request, or in chats
 * the inbound policy admits; anything else is refused with a tool error
 * before any MAX mutation.
 */

import { ToolAuthorizationError } from 'openclaw/plugin-sdk/channel-actions';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { maxMessageActions as actions } from './actions.js';
import { MaxApi, MaxApiError } from './api.js';
import { setMaxRuntime } from './runtime.js';

const ADMITTED_GROUP = -7001;
const OTHER_GROUP = -9999;
const ALLOWED_USER = 1001; // allowFrom
const PAIRED_USER = 5005; // pairing store
const STRANGER = 4004;

function makeCfg(extra: Record<string, unknown> = {}) {
  return {
    channels: {
      max: {
        botToken: 'test-token',
        dmPolicy: 'pairing',
        allowFrom: [String(ALLOWED_USER)],
        groupPolicy: 'allowlist',
        groups: { [String(ADMITTED_GROUP)]: {} },
        ...extra,
      },
    },
  };
}

/** A non-owner turn in `chatId` from `requester`. */
function turn(chatId: number, requester = STRANGER) {
  return {
    toolContext: { currentChannelId: `max:${chatId}`, currentChannelProvider: 'max' },
    requesterSenderId: String(requester),
    senderIsOwner: false,
  };
}

/** Dialog chat ids (positive) and the user each one is with. */
const DIALOGS: Record<number, number> = { 801: ALLOWED_USER, 800: STRANGER, 805: PAIRED_USER };

const spies = {} as Record<
  'send' | 'edit' | 'remove' | 'pin' | 'unpin' | 'getChat' | 'getMessage',
  ReturnType<typeof vi.spyOn>
>;
/** chat id of the message GET /messages/{mid} returns (edit/delete). */
let messageChat: number;

beforeEach(() => {
  vi.restoreAllMocks();
  setMaxRuntime({
    channel: {
      pairing: { readAllowFromStore: vi.fn(async () => [String(PAIRED_USER)]) },
    },
  } as never);
  spies.send = vi.spyOn(MaxApi.prototype, 'sendMessage').mockResolvedValue({
    message: { body: { mid: 'mid.sent' }, recipient: { chat_id: 1, chat_type: 'chat' } },
  } as never);
  spies.edit = vi.spyOn(MaxApi.prototype, 'editMessage').mockResolvedValue({ success: true });
  spies.remove = vi.spyOn(MaxApi.prototype, 'deleteMessage').mockResolvedValue({ success: true });
  spies.pin = vi.spyOn(MaxApi.prototype, 'pinMessage').mockResolvedValue({ success: true });
  spies.unpin = vi.spyOn(MaxApi.prototype, 'unpinMessage').mockResolvedValue({ success: true });
  spies.getChat = vi.spyOn(MaxApi.prototype, 'getChat').mockImplementation(async (chatId) => {
    const userId = DIALOGS[chatId];
    if (userId == null) {
      throw new MaxApiError('MAX API GET /chats → 404', 404, { code: 'chat.not.found' });
    }
    return {
      chat_id: chatId,
      type: 'dialog',
      status: 'active',
      dialog_with_user: { user_id: userId, first_name: 'U', is_bot: false },
    };
  });
  spies.getMessage = vi.spyOn(MaxApi.prototype, 'getMessageById').mockImplementation(async () => ({
    recipient: { chat_id: messageChat, chat_type: messageChat < 0 ? 'chat' : 'dialog' },
    timestamp: 1,
    body: { mid: 'mid.x' },
  }));
});

type ActionCase = {
  action: string;
  params: (target: number | string) => Record<string, unknown>;
  mutation: keyof typeof spies;
};

const ACTIONS: ActionCase[] = [
  { action: 'send', params: (to) => ({ target: String(to), message: 'hi' }), mutation: 'send' },
  {
    action: 'sendAttachment',
    params: (to) => ({ target: String(to), type: 'location', latitude: 55.7, longitude: 37.6 }),
    mutation: 'send',
  },
  {
    action: 'sticker',
    params: (to) => ({ target: String(to), stickerId: 'code' }),
    mutation: 'send',
  },
  { action: 'pin', params: (to) => ({ target: String(to), messageId: 'mid.1' }), mutation: 'pin' },
  { action: 'unpin', params: (to) => ({ target: String(to) }), mutation: 'unpin' },
  {
    action: 'edit',
    params: (chat) => {
      messageChat = Number(chat);
      return { messageId: 'mid.1', message: 'edited' };
    },
    mutation: 'edit',
  },
  {
    action: 'delete',
    params: (chat) => {
      messageChat = Number(chat);
      return { messageId: 'mid.1' };
    },
    mutation: 'remove',
  },
];

function run(
  item: ActionCase,
  target: number | string,
  context: Record<string, unknown>,
  cfg = makeCfg(),
) {
  return actions.handleAction!({
    action: item.action,
    params: item.params(target),
    cfg,
    ...context,
  } as never);
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a refusal');
}

describe.each(ACTIONS)('actionScope for $action', (item) => {
  it('allows the chat of the current turn', async () => {
    await run(item, OTHER_GROUP, turn(OTHER_GROUP));
    expect(spies[item.mutation]).toHaveBeenCalledTimes(1);
  });

  it('allows another chat the group policy admits', async () => {
    await run(item, ADMITTED_GROUP, turn(801, ALLOWED_USER));
    expect(spies[item.mutation]).toHaveBeenCalledTimes(1);
  });

  it('refuses a chat outside the group policy with a tool error, before any mutation', async () => {
    const err = await refusal(run(item, OTHER_GROUP, turn(ADMITTED_GROUP)));

    expect(err).toBeInstanceOf(ToolAuthorizationError);
    expect(err.message).toContain(`MAX ${item.action} refused`);
    expect(err.message).toContain(`chat ${OTHER_GROUP}`);
    expect(err.message).toContain('groups allowlist');
    expect(spies[item.mutation]).not.toHaveBeenCalled();
  });

  it('refuses an admitted group whose sender allowlist excludes the requester', async () => {
    const err = await refusal(
      run(item, ADMITTED_GROUP, turn(801, STRANGER), makeCfg({ groupAllowFrom: ['1001'] })),
    );
    expect(err).toBeInstanceOf(ToolAuthorizationError);
    expect(err.message).toContain('group allowFrom/groupAllowFrom');
    expect(spies[item.mutation]).not.toHaveBeenCalled();
  });

  it("allows an admitted group for a requester in the group's own allowFrom", async () => {
    await run(
      item,
      ADMITTED_GROUP,
      turn(801, STRANGER),
      makeCfg({
        groupAllowFrom: ['1001'],
        groups: { [String(ADMITTED_GROUP)]: { allowFrom: [`max:${STRANGER}`] } },
      }),
    );
    expect(spies[item.mutation]).toHaveBeenCalledTimes(1);
  });

  it('allows it for an owner request', async () => {
    await run(item, OTHER_GROUP, { ...turn(ADMITTED_GROUP), senderIsOwner: true });
    expect(spies[item.mutation]).toHaveBeenCalledTimes(1);
  });

  it('refuses an admitted but foreign chat under actionScope="current"', async () => {
    const err = await refusal(
      run(item, ADMITTED_GROUP, turn(-7002), makeCfg({ actionScope: 'current' })),
    );
    expect(err).toBeInstanceOf(ToolAuthorizationError);
    expect(err.message).toContain('actionScope="current"');
    expect(spies[item.mutation]).not.toHaveBeenCalled();
  });

  it('keeps 0.7 behavior under actionScope="off"', async () => {
    await run(item, OTHER_GROUP, turn(ADMITTED_GROUP), makeCfg({ actionScope: 'off' }));
    expect(spies[item.mutation]).toHaveBeenCalledTimes(1);
  });

  // CLI `openclaw message` passes senderIsOwner=true by default.
  it('does not scope an owner call without a conversation (CLI)', async () => {
    await run(item, OTHER_GROUP, { senderIsOwner: true });
    expect(spies[item.mutation]).toHaveBeenCalledTimes(1);
  });

  // Core hands the conversation over only from a trusted channel turn; agent
  // runs started by plugins or hooks come without one and senderIsOwner=false.
  it('scopes a non-owner run without a conversation to admitted chats', async () => {
    const err = await refusal(run(item, OTHER_GROUP, { senderIsOwner: false }));
    expect(err).toBeInstanceOf(ToolAuthorizationError);
    expect(spies[item.mutation]).not.toHaveBeenCalled();

    await run(item, ADMITTED_GROUP, { senderIsOwner: false });
    expect(spies[item.mutation]).toHaveBeenCalledTimes(1);
  });
});

// Runs without a trusted turn: core passes no conversation and no requester,
// and the owner flag may be missing. Only senderIsOwner=true skips the scope.
describe.each([
  ['heartbeat (no owner flag)', { sessionKey: 'agent:main:main' }],
  ['subagent (not the owner)', { sessionKey: 'agent:main:subagent:s1', senderIsOwner: false }],
  ['scheduled run without message authority', { requesterAccountId: 'default' }],
])('a %s', (_label, context) => {
  it.each(ACTIONS)('acts with $action in an admitted chat', async (item) => {
    await run(item, ADMITTED_GROUP, context);
    expect(spies[item.mutation]).toHaveBeenCalledTimes(1);
  });

  it.each(ACTIONS)('is refused $action in a chat the policy does not admit', async (item) => {
    const err = await refusal(run(item, OTHER_GROUP, context));
    expect(err).toBeInstanceOf(ToolAuthorizationError);
    expect(err.message).toContain('groups allowlist');
    expect(spies[item.mutation]).not.toHaveBeenCalled();
  });

  it('is refused a group whose sender allowlist it cannot pass (no requester)', async () => {
    const err = await refusal(
      run(ACTIONS[0], ADMITTED_GROUP, context, makeCfg({ groupAllowFrom: ['1001'] })),
    );
    expect(err).toBeInstanceOf(ToolAuthorizationError);
    expect(spies.send).not.toHaveBeenCalled();
  });
});

describe('dialogs follow the DM policy', () => {
  const send = ACTIONS[0];

  it.each([
    ['user in allowFrom', `user:${ALLOWED_USER}`],
    ['user in the pairing store', `user:${PAIRED_USER}`],
    ['dialog chat id with an allowed user', 801],
    ['dialog chat id with a paired user', 805],
  ])('allows a %s', async (_label, target) => {
    await run(send, target, turn(ADMITTED_GROUP));
    expect(spies.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['user outside allowFrom and pairing', `user:${STRANGER}`],
    ['dialog chat id with a stranger', 800],
    ['positive id that is no chat (a user id)', 802],
  ])('refuses a %s', async (_label, target) => {
    const err = await refusal(run(send, target, turn(ADMITTED_GROUP, ALLOWED_USER)));
    expect(err).toBeInstanceOf(ToolAuthorizationError);
    expect(err.message).toContain('allowFrom or the pairing store');
    expect(spies.send).not.toHaveBeenCalled();
  });

  it('refuses every dialog under dmPolicy="disabled"', async () => {
    const err = await refusal(
      run(send, `user:${ALLOWED_USER}`, turn(ADMITTED_GROUP), makeCfg({ dmPolicy: 'disabled' })),
    );
    expect(err.message).toContain('dmPolicy=disabled');
  });

  it("allows the requester's own dialog from a DM turn, addressed as user:<id>", async () => {
    await run(send, `user:${STRANGER}`, turn(800, STRANGER));
    expect(spies.send).toHaveBeenCalledTimes(1);
    expect(spies.getChat).not.toHaveBeenCalled();
  });

  it('allows a group under groupPolicy="open" and refuses every group under "disabled"', async () => {
    await run(send, OTHER_GROUP, turn(ADMITTED_GROUP), makeCfg({ groupPolicy: 'open' }));
    expect(spies.send).toHaveBeenCalledTimes(1);

    const err = await refusal(
      run(send, ADMITTED_GROUP, turn(801), makeCfg({ groupPolicy: 'disabled' })),
    );
    expect(err.message).toContain('groupPolicy=disabled');
  });
});

describe('edit and delete resolve the chat of the message', () => {
  const [edit, remove] = ACTIONS.slice(5);

  it('edits a message in the current chat with one lookup', async () => {
    await run(edit, ADMITTED_GROUP, turn(ADMITTED_GROUP));
    expect(spies.getMessage).toHaveBeenCalledWith('mid.1');
    expect(spies.getChat).not.toHaveBeenCalled();
    expect(spies.edit).toHaveBeenCalledTimes(1);
  });

  it('checks the peer of a dialog message against the DM policy', async () => {
    await run(remove, 801, turn(ADMITTED_GROUP));
    expect(spies.remove).toHaveBeenCalledTimes(1);

    const err = await refusal(run(remove, 800, turn(ADMITTED_GROUP)));
    expect(err.message).toContain(`the dialog with user ${STRANGER}`);
  });

  it('refuses when the message chat cannot be resolved (fail-closed)', async () => {
    spies.getMessage.mockRejectedValueOnce(new MaxApiError('MAX API GET → 404', 404));

    const err = await refusal(run(remove, ADMITTED_GROUP, turn(ADMITTED_GROUP)));

    expect(err).toBeInstanceOf(ToolAuthorizationError);
    expect(err.message).toContain('cannot resolve the chat of message mid.1');
    expect(spies.remove).not.toHaveBeenCalled();
  });
});

describe('the current chat belongs to the account of the turn', () => {
  // A second bot whose own policy admits no group.
  const cfg = makeCfg({ accounts: { second: { botToken: 'second-token', groups: {} } } });

  it('holds another account acting in the chat of the turn to its own policy', async () => {
    const context = { ...turn(OTHER_GROUP), requesterAccountId: 'default', accountId: 'second' };

    const err = await refusal(run(ACTIONS[0], OTHER_GROUP, context, cfg));

    expect(err).toBeInstanceOf(ToolAuthorizationError);
    expect(spies.send).not.toHaveBeenCalled();
  });

  it('keeps the chat of the turn current for the account the turn came in on', async () => {
    const context = { ...turn(OTHER_GROUP), requesterAccountId: 'second', accountId: 'second' };

    await run(ACTIONS[0], OTHER_GROUP, context, cfg);

    expect(spies.send).toHaveBeenCalledTimes(1);
  });
});

// Core delivers message(action=send) with a presentation through the outbound
// adapter (message-action-runner: corePayload when prepareSendPayload is
// missing and the adapter has sendPayload), so handleAction never sees it.
describe('sends core delivers itself (presentation) are scoped before delivery', () => {
  const presentation = { blocks: [{ type: 'text', text: 'Deploy?' }] };
  async function prepare(to: number, context: Record<string, unknown>, cfg = makeCfg()) {
    return await actions.prepareSendPayload!({
      ctx: { action: 'send', cfg, params: {}, ...context } as never,
      to: String(to),
      payload: { text: 'hi', presentation } as never,
    });
  }

  it('refuses a chat outside the policy before core delivers', async () => {
    const err = await refusal(prepare(OTHER_GROUP, turn(ADMITTED_GROUP)));

    expect(err).toBeInstanceOf(ToolAuthorizationError);
  });

  it('hands the payload back unchanged for an allowed chat and an owner', async () => {
    await expect(prepare(ADMITTED_GROUP, turn(801))).resolves.toMatchObject({ presentation });
    await expect(
      prepare(OTHER_GROUP, { ...turn(ADMITTED_GROUP), senderIsOwner: true }),
    ).resolves.toMatchObject({ presentation });
  });

  it('keeps plain sends on the handleAction path (null)', async () => {
    const result = await actions.prepareSendPayload!({
      ctx: { action: 'send', cfg: makeCfg(), params: {}, ...turn(ADMITTED_GROUP) } as never,
      to: String(OTHER_GROUP),
      payload: { text: 'hi' } as never,
    });

    expect(result).toBeNull();
  });

  it('refuses a presentation send when channels.max.actions.send is false', async () => {
    const err = await refusal(
      prepare(ADMITTED_GROUP, { senderIsOwner: true }, makeCfg({ actions: { send: false } })),
    );

    expect(err.message).toContain('disabled by channels.max.actions');
  });
});
