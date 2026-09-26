/**
 * Directory and addressing of the MAX channel: self, peers from allowFrom,
 * groups from the passive chat registry, numeric target normalization.
 */

import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";

import { type ResolvedMaxAccount, resolveMaxAccount } from "./accounts.js";
import { MaxApi } from "./api.js";
import { loadMaxAccountState } from "./state.js";

type MaxChannelPlugin = ChannelPlugin<ResolvedMaxAccount>;

/** Targets are numeric chat/user ids with an optional max: prefix. */
export const maxMessagingAdapter: NonNullable<MaxChannelPlugin["messaging"]> = {
  normalizeTarget: (raw) => {
    const trimmed = raw.trim();
    const normalized = trimmed.startsWith('max:') ? trimmed.slice(4) : trimmed;
    // MAX uses numeric IDs
    if (/^-?\d+$/.test(normalized)) return normalized;
    return undefined;
  },
  targetResolver: {
    looksLikeId: (raw) => /^-?\d+$/.test(raw.trim().replace(/^max:/, '')),
    hint: '<chatId|userId>',
  },
};

/** MAX has no member/chat listing for bots: peers come from allowFrom, groups from the chat registry. */
export const maxDirectoryAdapter: NonNullable<MaxChannelPlugin["directory"]> = {
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
