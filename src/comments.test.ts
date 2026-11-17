import { beforeEach, describe, expect, it, vi } from 'vitest';

import { maxMessageActions } from './actions.js';
import { MaxApi } from './api.js';
import { maxOutboundAdapter } from './channel-outbound.js';

const to = 'max:-42';
const threadId = 'mid.post';
const messageId = 'mid.comment';
const message = {
  body: { mid: messageId, text: 'test' },
  recipient: { chat_type: 'channel', chat_id: -42, post_id: threadId },
  sender: { user_id: 55 },
};
const post = { body: { mid: threadId }, recipient: { chat_type: 'channel', chat_id: -42 } };
const cfg = { channels: { max: { botToken: 'mock', groupPolicy: 'open' } } };
const turn = { currentChannelProvider: 'max', currentChannelId: to, currentThreadTs: threadId };
const calls: { method: string; path: string; body: unknown }[] = [];
function action(action: string, params: Record<string, unknown> = {}, extra = {}) {
  return maxMessageActions.handleAction!({
    cfg,
    action,
    params: { target: to, threadId, ...params },
    senderIsOwner: true,
    ...extra,
  } as never);
}
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input);
      const method = init.method!;
      calls.push({
        method,
        path: url.pathname + url.search,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const path = url.pathname;
      const result =
        path === '/me'
          ? { user_id: 88 }
          : path === '/messages/mid.post'
            ? post
            : path === '/messages/mid.post/comments/mid.comment'
              ? message
              : path === '/messages/mid.post/comments'
                ? method === 'GET'
                  ? { messages: [message] }
                  : method === 'POST'
                    ? { message }
                    : { success: true }
                : null;
      return {
        ok: result !== null,
        status: result !== null ? 200 : 404,
        json: async () => result ?? { code: 'not.found' },
      };
    }),
  );
});

describe('MAX post comments', () => {
  it('uses the nested endpoints, separate IDs, documented filters and reply link', async () => {
    const api = new MaxApi({ token: 'mock' });
    await api.getComments(threadId, { comment_ids: ['a', 'b'], before: 0, after: 1, count: 7 });
    expect(new URL('https://test.invalid' + calls[0].path).searchParams.get('comment_ids')).toBe(
      'a,b',
    );
    expect(calls[0].path).toContain('before=0');
    await action('read', { limit: 2 });
    await action('read', { messageId });
    await action('send', { replyTo: messageId, message: 'hello' });
    await action('edit', { messageId, message: 'edit' });
    await action('delete', { messageId });
    expect(calls.filter((c) => c.path !== '/messages/mid.post').slice(1)).toEqual([
      { method: 'GET', path: '/messages/mid.post/comments?count=2', body: undefined },
      { method: 'GET', path: '/messages/mid.post/comments/mid.comment', body: undefined },
      { method: 'GET', path: '/messages/mid.post/comments/mid.comment', body: undefined },
      {
        method: 'POST',
        path: '/messages/mid.post/comments',
        body: { text: 'hello', format: 'markdown', link: { type: 'reply', mid: messageId } },
      },
      {
        method: 'PUT',
        path: '/messages/mid.post/comments?comment_id=mid.comment',
        body: { text: 'edit', format: 'markdown' },
      },
      {
        method: 'DELETE',
        path: '/messages/mid.post/comments?comment_id=mid.comment',
        body: undefined,
      },
    ]);
  });
  it('inherits the SDK currentThreadTs only for the same MAX chat/account', async () => {
    const params = { threadId: undefined };
    await action('read', params, { toolContext: turn, requesterAccountId: 'default' });
    for (const extra of [
      { toolContext: { ...turn, currentChannelProvider: 'telegram' } },
      { toolContext: { ...turn, currentChannelId: 'max:-99' } },
      { toolContext: turn, requesterAccountId: 'other' },
    ]) {
      await expect(action('read', params, extra)).rejects.toThrow(
        'requires a channel post threadId',
      );
    }
    expect(calls).toHaveLength(2);
  });
  it('handles the SDK message-tool envelope, without publishing a root message for a null threadId', async () => {
    const params = {
      action: 'send',
      channel: 'max',
      accountId: 'default',
      target: to,
      to,
      threadId: null,
      replyTo: messageId,
      media: undefined,
      mediaUrls: [],
      bestEffort: true,
      idempotencyKey: 'sdk-generated',
      message: 'reply',
    };
    const context = {
      cfg: { channels: { max: { botToken: 'mock', notify: false } } },
      toolContext: { ...turn, currentChannelProvider: undefined },
      reply: { source: 'implicit', replyToId: messageId, mode: 'first' },
    };
    expect(
      await maxMessageActions.prepareSendPayload!({
        ctx: { ...context, params },
        to,
        threadId: null,
        replyToId: messageId,
        payload: { text: 'reply' },
      } as never),
    ).toBeNull();
    await action('send', params, context);
    expect(calls.map((c) => c.path)).toEqual([
      '/messages/mid.post',
      '/messages/mid.post/comments/mid.comment',
      '/messages/mid.post/comments',
    ]);
  });
  it('refuses out-of-scope targets before any lookup of the requested post', async () => {
    await expect(
      action(
        'read',
        { target: 'max:-43' },
        {
          senderIsOwner: false,
          toolContext: turn,
          cfg: { channels: { max: { botToken: 'mock', actionScope: 'current' } } },
        },
      ),
    ).rejects.toThrow('outside');
    expect(calls).toHaveLength(0);
  });
  it.each(['send', 'edit', 'delete', 'read'])(
    'checks the %s gate before looking up a post',
    async (name) => {
      await expect(
        action(
          name,
          {},
          { cfg: { channels: { max: { botToken: 'mock', actions: { [name]: false } } } } },
        ),
      ).rejects.toThrow('disabled');
      expect(calls).toHaveLength(0);
    },
  );
  it('does not redirect a post into a different channel, quote across posts or mutate a foreign comment outside the current chat', async () => {
    await expect(action('send', { target: 'max:-43', message: 'x' })).rejects.toThrow(
      'target channel',
    );
    await expect(action('send', { replyTo: 'mid.other', message: 'x' })).rejects.toThrow();
    await expect(
      action(
        'delete',
        { messageId },
        {
          senderIsOwner: false,
          requesterSenderId: '1',
          toolContext: { ...turn, currentChannelId: 'max:-43' },
        },
      ),
    ).rejects.toThrow('not sent by this bot');
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
  it('rejects media, pins, silent sends, unsupported actions and prepared presentations without normal sends', async () => {
    for (const field of [
      { attachments: [{ url: 'https://test.invalid' }] },
      { pin: true },
      { silent: true },
      { buttons: [[]] },
      { notify: false },
    ]) {
      await expect(action('send', { message: 'hello', ...field })).rejects.toThrow(
        'unsupported option',
      );
    }
    await expect(action('pin', { messageId })).rejects.toThrow('do not support action');
    await expect(
      maxMessageActions.prepareSendPayload!({
        ctx: { cfg, params: { threadId } },
        to,
        threadId,
        payload: { text: 'hello', presentation: { blocks: [] } },
      } as never),
    ).rejects.toThrow('presentation');
    expect(calls).toHaveLength(0);
  });
  it('sends direct SDK text to the post; rejects media before uploading or creating a root message', async () => {
    const ctx = { cfg, to, threadId, text: 'sdk' };
    await expect(maxOutboundAdapter.sendText!(ctx as never)).resolves.toEqual({
      channel: 'max',
      messageId,
    });
    await expect(
      maxOutboundAdapter.sendMedia!({ ...ctx, mediaUrl: 'file:///nope' } as never),
    ).rejects.toThrow('text only');
    await expect(
      maxOutboundAdapter.sendPayload!({
        ...ctx,
        payload: { text: 'x', delivery: { pin: true } },
      } as never),
    ).rejects.toThrow('delivery');
    expect(calls.map((c) => c.path)).toEqual(['/messages/mid.post', '/messages/mid.post/comments']);
  });
});
