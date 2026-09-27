/**
 * Scoping of message-tool actions to chats the channel policy admits. Core
 * guards cross-conversation mutations only when tools.message.crossContext
 * is tightened (both options default to allow), and never guards edit/delete
 * addressed by messageId alone: without this check a prompt injection in one
 * chat could post, edit, delete or pin in any other chat of the bot.
 */

import { ToolAuthorizationError } from 'openclaw/plugin-sdk/channel-actions';
import type { ChannelMessageActionContext } from 'openclaw/plugin-sdk/channel-contract';
import { normalizeAccountId } from 'openclaw/plugin-sdk/core';

import { admitMaxDmUser, admitMaxGroupMessage, type MaxAdmission } from './access-policy.js';
import type { ResolvedMaxAccount } from './accounts.js';
import { MaxApi, MaxApiError } from './api.js';
import { isChatNotFound } from './send.js';
import type { MaxMessage } from './types.js';

/**
 * - `admitted` (default): the current chat of the turn, an owner request
 *   (senderIsOwner=true), or a chat the inbound policy admits (DM policy with
 *   allowFrom and pairing, group policy with its chat and sender allowlists);
 * - `current`: a non-owner turn acts only in its own chat;
 * - `off`: no plugin check (0.7.x behavior; core policy only).
 */
export type MaxActionScope = 'admitted' | 'current' | 'off';

/** The chat an action lands in. */
type MaxSettledChat =
  { kind: 'group'; chatId: number } | { kind: 'dialog'; chatId?: number; userId?: number };

/** As located before any GET /chats: `unknown` is a positive id not yet classified. */
type MaxActionChat = MaxSettledChat | { kind: 'unknown'; chatId: number };

/**
 * What the action addresses: an explicit target (with the message a send
 * replies to, if any) or an existing message.
 */
export type MaxActionTarget = { to: string; replyTo?: string | null } | { messageId: string };

/**
 * Throws ToolAuthorizationError (a tool error the agent sees) when the action
 * may not run in its chat under channels.max.actionScope. Only a call core
 * marks senderIsOwner=true is not scoped (CLI `openclaw message`, an admin's
 * Control UI chat, the owner's turn). Every other call, the flag missing
 * included (heartbeat, subagents, scheduled runs without message authority),
 * is held to the chats the inbound policy admits.
 */
export async function assertMaxActionInScope(
  ctx: ChannelMessageActionContext,
  account: ResolvedMaxAccount,
  target: MaxActionTarget,
): Promise<void> {
  const scope: MaxActionScope = account.config.actionScope ?? 'admitted';
  if (scope === 'off' || ctx.senderIsOwner === true) return;

  const turnChatId = readCurrentMaxChatId(ctx);
  const requesterId = ctx.requesterSenderId?.trim() || undefined;
  // The turn's chat is current only for the account the turn came in on:
  // another bot of the same group is held to its own policy.
  const turnAccountId = ctx.requesterAccountId?.trim();
  const currentChatId =
    !turnAccountId || normalizeAccountId(turnAccountId) === account.accountId
      ? turnChatId
      : undefined;

  const api = new MaxApi({ token: account.token });
  const { chat: located, authorId } = await failClosed(ctx.action, target, () =>
    locateActionChat(api, target),
  );
  const replyTo = 'to' in target ? target.replyTo?.trim() || undefined : undefined;
  if (isCurrentChat(located, currentChatId, requesterId)) {
    if (replyTo) await assertReplyInChat(ctx, api, replyTo, located, currentChatId);
    return;
  }

  if (scope === 'current') {
    deny(
      ctx.action,
      describeChat(located),
      'actionScope="current" allows only the chat of the current turn',
    );
  }
  const chat = await failClosed(ctx.action, target, () => classifyChat(api, located));
  // A group admits the action only for a requester its sender allowlist admits.
  const admission: MaxAdmission =
    chat.kind === 'group'
      ? admitMaxGroupMessage(account, ctx.cfg, chat.chatId, requesterId)
      : await admitMaxDmUser(account, chat.userId);
  if (!admission.admitted) deny(ctx.action, describeChat(chat), admission.reason);
  // Outside the chat of the turn, edit and delete reach only the bot's own
  // messages: what others wrote in an admitted chat is not the agent's to change.
  if ('messageId' in target) await assertBotMessage(ctx.action, api, target.messageId, authorId);
  if (replyTo) await assertReplyInChat(ctx, api, replyTo, chat);
}

/**
 * A reply quotes its message in the chat it is sent to: that message must
 * belong to the same chat, or the quote would carry another chat's text
 * there. GET /messages/{mid} runs only for a reply; the message that started
 * the turn needs no lookup in its own chat.
 */
async function assertReplyInChat(
  ctx: ChannelMessageActionContext,
  api: MaxApi,
  replyTo: string,
  target: MaxActionChat,
  currentChatId?: string,
): Promise<void> {
  const turnMessageId = ctx.toolContext?.currentMessageId;
  if (currentChatId && turnMessageId != null && String(turnMessageId).trim() === replyTo) return;
  const refuse = (why: string): never => {
    throw new ToolAuthorizationError(
      `MAX ${ctx.action} refused: replyTo message ${replyTo} ${why}; a reply may quote only a message ` +
        `of the chat it is sent to, here ${describeChat(target)} (channels.max.actionScope).`,
    );
  };
  let replyChat: MaxActionChat;
  try {
    replyChat = chatOfMessage(await api.getMessageById(replyTo));
  } catch (err) {
    return refuse(`cannot be resolved to a chat (${String(err)})`);
  }
  const targetChatId = target.chatId ?? (currentChatId != null ? Number(currentChatId) : undefined);
  if (targetChatId != null && replyChat.chatId === targetChatId) return;
  // A dialog addressed by user id: the reply must sit in the dialog with that user.
  if (target.kind === 'dialog' && targetChatId == null && target.userId != null) {
    let peer: MaxSettledChat;
    try {
      peer = await classifyChat(api, replyChat);
    } catch (err) {
      return refuse(`cannot be resolved to a chat (${String(err)})`);
    }
    if (peer.kind === 'dialog' && peer.chatId != null && peer.userId === target.userId) return;
  }
  refuse(`belongs to another chat (${describeChat(replyChat)})`);
}

/** The author comes from the same GET /messages/{mid} as the chat; the bot id is remembered. */
async function assertBotMessage(
  action: string,
  api: MaxApi,
  messageId: string,
  authorId: number | undefined,
): Promise<void> {
  let botUserId: number;
  try {
    botUserId = await api.getBotUserId();
  } catch (err) {
    throw new ToolAuthorizationError(
      `MAX ${action} refused: cannot resolve the bot's own user id to check the author of message ${messageId} (${String(err)})`,
    );
  }
  if (authorId != null && authorId === botUserId) return;
  throw new ToolAuthorizationError(
    `MAX ${action} refused: message ${messageId} was not sent by this bot. Outside the chat of the current turn ` +
      'only messages the bot sent itself may be edited or deleted (channels.max.actionScope).',
  );
}

function deny(action: string, chat: string, reason: string): never {
  throw new ToolAuthorizationError(
    `MAX ${action} refused: ${chat} is outside the chats this conversation may act in (${reason}). ` +
      'Allowed: the current chat, chats admitted by channels.max dmPolicy/allowFrom/pairing and ' +
      'groupPolicy/groups/groupAllowFrom, or a request from the owner (channels.max.actionScope).',
  );
}

/** Chat id of the current MAX turn (toolContext.currentChannelId is `max:<chatId>`). */
function readCurrentMaxChatId(ctx: ChannelMessageActionContext): string | undefined {
  const tool = ctx.toolContext;
  if (!tool) return undefined;
  if (tool.currentChannelProvider && tool.currentChannelProvider !== 'max') return undefined;
  const raw = tool.currentChannelId?.trim() || tool.currentMessagingTarget?.trim();
  if (!raw) return undefined;
  const id = raw.replace(/^max:/, '');
  return /^-?\d+$/.test(id) ? id : undefined;
}

/**
 * The current chat itself, or — from a DM turn — the requester's own dialog
 * addressed as user:<id>.
 */
function isCurrentChat(
  chat: MaxActionChat,
  currentChatId: string | undefined,
  requesterId: string | undefined,
): boolean {
  if (currentChatId && chat.chatId != null && String(chat.chatId) === currentChatId) return true;
  const currentIsDialog = currentChatId != null && !currentChatId.startsWith('-');
  return (
    chat.kind === 'dialog' &&
    currentIsDialog &&
    chat.userId != null &&
    requesterId === String(chat.userId)
  );
}

function describeChat(chat: MaxActionChat): string {
  if (chat.kind === 'dialog') {
    return chat.userId != null ? `the dialog with user ${chat.userId}` : `dialog ${chat.chatId}`;
  }
  return `chat ${chat.chatId}`;
}

/** Target resolution failures refuse the action (fail-closed). */
async function failClosed<T>(
  action: string,
  target: MaxActionTarget,
  resolve: () => Promise<T>,
): Promise<T> {
  try {
    return await resolve();
  } catch (err) {
    const what = 'messageId' in target ? `message ${target.messageId}` : `target ${target.to}`;
    throw new ToolAuthorizationError(
      `MAX ${action} refused: cannot resolve the chat of ${what} to check channels.max.actionScope (${String(err)})`,
    );
  }
}

/**
 * Where the action lands, without an API call for explicit targets:
 * user:<id> is a dialog, a negative id a group or channel, a positive id is
 * classified later. An existing message is looked up (GET /messages/{mid}),
 * which also tells its author.
 */
async function locateActionChat(
  api: MaxApi,
  target: MaxActionTarget,
): Promise<{ chat: MaxActionChat; authorId?: number }> {
  if ('messageId' in target) {
    const message = await api.getMessageById(target.messageId);
    return { chat: chatOfMessage(message), authorId: message.sender?.user_id };
  }
  const to = target.to.trim().replace(/^max:/, '');
  if (to.startsWith('user:')) {
    const userId = Number(to.slice(5));
    if (!Number.isFinite(userId)) throw new Error(`invalid MAX target: ${target.to}`);
    return { chat: { kind: 'dialog', userId } };
  }
  const chatId = Number(to);
  if (!to || !Number.isFinite(chatId)) throw new Error(`invalid MAX target: ${target.to}`);
  return { chat: chatId < 0 ? { kind: 'group', chatId } : { kind: 'unknown', chatId } };
}

function chatOfMessage(message: MaxMessage): MaxActionChat {
  const chatId = message.recipient?.chat_id;
  if (chatId == null) throw new Error('the message has no recipient chat');
  const chatType = message.recipient?.chat_type;
  if (chatType === 'chat' || chatType === 'channel') return { kind: 'group', chatId };
  if (chatType === 'dialog') return { kind: 'dialog', chatId };
  return chatId < 0 ? { kind: 'group', chatId } : { kind: 'unknown', chatId };
}

/**
 * Settle a positive id (GET /chats: dialog or group; chat.not.found means a
 * user id, which the send path retries as user_id) and a dialog's peer.
 */
async function classifyChat(api: MaxApi, chat: MaxActionChat): Promise<MaxSettledChat> {
  if (chat.kind === 'group') return chat;
  if (chat.kind === 'dialog' && (chat.userId != null || chat.chatId == null)) return chat;
  const chatId = chat.chatId as number;
  try {
    const info = await api.getChat(chatId);
    if (info.type !== 'dialog') return { kind: 'group', chatId };
    return { kind: 'dialog', chatId, userId: info.dialog_with_user?.user_id };
  } catch (err) {
    if (chat.kind === 'unknown' && err instanceof MaxApiError && isChatNotFound(err)) {
      return { kind: 'dialog', userId: chatId };
    }
    throw err;
  }
}
