/** Text-only MAX channel post comments. The parent mid is never a chat address. */
import type { ChannelMessageActionContext } from 'openclaw/plugin-sdk/channel-contract';

import type { ResolvedMaxAccount } from './accounts.js';
import { currentMaxChatForAccount } from './action-scope.js';
import type { MaxApi } from './api.js';
import { resolveMaxTableMode, toMaxMarkdown } from './format.js';

export function commentMid(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:mid\.)?[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('MAX comments require a valid string mid');
  }
  return value;
}

export function resolveCommentPost(
  ctx: ChannelMessageActionContext,
  account: ResolvedMaxAccount,
  to?: string,
): string | undefined {
  if (ctx.params.threadId != null) {
    if (ctx.params.topLevel === true) throw new Error('MAX threadId conflicts with topLevel');
    return commentMid(ctx.params.threadId);
  }
  if (ctx.params.topLevel === true) return undefined;
  const tool = ctx.toolContext;
  const chatId = currentMaxChatForAccount(ctx, account);
  if (
    !tool?.currentThreadTs ||
    !chatId ||
    (to != null && to.trim().replace(/^max:/, '') !== chatId)
  )
    return undefined;
  return commentMid(tool.currentThreadTs);
}

export async function assertCommentPost(api: MaxApi, to: string, postId: string): Promise<void> {
  const target = to.trim().replace(/^max:/, '');
  if (!/^-?\d+$/.test(target)) throw new Error('MAX comments require a channel chat ID as target');
  const post = await api.getMessageById(commentMid(postId));
  if (
    post.recipient.chat_type !== 'channel' ||
    String(post.recipient.chat_id) !== target ||
    post.recipient.post_id ||
    (post.body && post.body.mid !== postId)
  ) {
    throw new Error('MAX threadId is not a post of the target channel');
  }
}

export function commentText(account: ResolvedMaxAccount, text: string) {
  const formatted = toMaxMarkdown(text, { tableMode: resolveMaxTableMode(account.config) });
  if (!formatted.trim() || formatted.length > 4000)
    throw new Error('MAX comments require 1–4000 characters of text');
  return { text: formatted, format: 'markdown' as const };
}

/** Call only after verifying the post against the target. No /messages send fallback. */
export async function sendTextComment(
  api: MaxApi,
  account: ResolvedMaxAccount,
  postId: string,
  text: string,
  replyTo?: string | null,
  beforeSend?: () => void,
) {
  const body: Parameters<MaxApi['sendComment']>[1] = commentText(account, text);
  // A reply to the post itself is represented by the comment endpoint. A quoted
  // comment must resolve under *this* post, even for owner or unscoped calls.
  if (replyTo != null && replyTo !== postId) {
    const mid = commentMid(replyTo);
    const comment = await api.getCommentById(postId, mid);
    if (comment.body?.mid !== mid) throw new Error('MAX replyTo is not a comment of this post');
    body.link = { type: 'reply', mid };
  }
  beforeSend?.();
  const result = await api.sendComment(postId, body, account.config.disableLinkPreview);
  if (!result.message.body?.mid) throw new Error('MAX returned no comment mid');
  return result.message.body.mid;
}

/** Reject rather than silently discarding unsupported intent. Core may include
 * undefined fields, false media flags and empty normalized media lists. */
export function assertCommentFields(fields: Record<string, unknown>, allowed: readonly string[]) {
  for (const [key, value] of Object.entries(fields)) {
    if (
      allowed.includes(key) ||
      value == null ||
      (value === false &&
        [
          'asVoice',
          'audioAsVoice',
          'videoAsNote',
          'asVideoNote',
          'pin',
          'silent',
          'replyToCurrent',
          'replyToTag',
        ].includes(key)) ||
      (Array.isArray(value) && value.length === 0)
    )
      continue;
    throw new Error(`MAX comments support text only; unsupported option: ${key}`);
  }
}
