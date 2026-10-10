/**
 * Directory and addressing of the MAX channel: self, peers from allowFrom,
 * groups from the passive chat registry, numeric target normalization.
 */

import type { ChannelPlugin } from 'openclaw/plugin-sdk/channel-core';

import { type ResolvedMaxAccount, resolveMaxAccount } from './accounts.js';
import { MaxApi } from './api.js';
import { MAX_DEFAULT_TABLE_MODE } from './format.js';
import { loadMaxAccountState } from './state.js';

type MaxChannelPlugin = ChannelPlugin<ResolvedMaxAccount>;

/** `user:<id>` addresses a user (DM); a bare number is a chat id. */
const MAX_TARGET_PATTERN = /^(?:user:\d+|-?\d+)$/;

function stripMaxPrefix(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith('max:') ? trimmed.slice(4) : trimmed;
}

/**
 * Targets are numeric chat ids or `user:<id>`, with an optional max: prefix.
 * The `user:` prefix must survive normalization: dropping it turns a user id
 * into a chat_id and MAX answers dialog.not.found.
 */
export const maxMessagingAdapter: NonNullable<MaxChannelPlugin['messaging']> = {
  normalizeTarget: (raw) => {
    const normalized = stripMaxPrefix(raw);
    return MAX_TARGET_PATTERN.test(normalized) ? normalized : undefined;
  },
  targetResolver: {
    looksLikeId: (raw) => MAX_TARGET_PATTERN.test(stripMaxPrefix(raw)),
    hint: '<chatId|user:userId>',
  },
  // Default of markdown.tables for core's resolver; the plugin applies the
  // same default itself (format.ts).
  defaultMarkdownTableMode: MAX_DEFAULT_TABLE_MODE,
};

/** MAX has no member/chat listing for bots: peers come from allowFrom, groups from the chat registry. */
export const maxDirectoryAdapter: NonNullable<MaxChannelPlugin['directory']> = {
  self: async ({ cfg, accountId }) => {
    const account = resolveMaxAccount({ cfg, accountId });
    if (!account.token) return null;
    try {
      const api = new MaxApi({ token: account.token, timeoutMs: 3000 });
      const me = await api.getMe();
      return {
        kind: 'user' as const,
        id: String(me.user_id),
        name: me.first_name || undefined,
        handle: me.username || undefined,
      };
    } catch {
      return null;
    }
  },
  listPeers: async ({ cfg, accountId }) => {
    const account = resolveMaxAccount({ cfg, accountId });
    // MAX doesn't expose a full user list API. Return peers from allowFrom config.
    const allowFrom = account.config.allowFrom ?? [];
    return allowFrom.map((id: string | number) => ({
      kind: 'user' as const,
      id: String(id),
      name: undefined,
    }));
  },
  listGroups: async ({ cfg, accountId }) => {
    const account = resolveMaxAccount({ cfg, accountId });
    if (!account.token) return [];

    const groups = new Map<string, { kind: 'channel' | 'group'; id: string; name?: string }>();

    // Реестр чатов пополняется событиями bot_added, chat_title_changed и сообщениями групп.
    try {
      const state = await loadMaxAccountState(account.accountId);
      for (const entry of Object.values(state.chats ?? {})) {
        if (entry.removedAt) continue;
        if (entry.type !== 'chat' && entry.type !== 'channel') continue;
        groups.set(String(entry.chatId), {
          kind: entry.type === 'channel' ? 'channel' : 'group',
          id: String(entry.chatId),
          name: entry.title || undefined,
        });
      }
    } catch {
      // При недоступности реестра вернуть пустой список.
    }

    return [...groups.values()];
  },
};
