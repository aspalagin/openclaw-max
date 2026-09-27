/**
 * Chat admission rules shared by the inbound gate and message-tool action
 * scoping: the DM policy with allowFrom and the pairing store, the group
 * policy with its allowlist, the group sender allowlist.
 */

import { isSenderIdAllowed, resolveGroupAllowFromSources } from 'openclaw/plugin-sdk/allow-from';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { DEFAULT_ACCOUNT_ID } from 'openclaw/plugin-sdk/core';

import { maxAccountConfigPath, type ResolvedMaxAccount } from './accounts.js';
import { getMaxRuntime } from './runtime.js';

export type MaxAdmission = { admitted: true } | { admitted: false; reason: string };

/** Effective group policy: account, then channels.defaults, then allowlist. */
export function resolveMaxGroupPolicy(account: ResolvedMaxAccount, config: OpenClawConfig): string {
  return account.config.groupPolicy ?? config.channels?.defaults?.groupPolicy ?? 'allowlist';
}

/** Whether a group chat passes the group policy (disabled / allowlist with "*" / open) and is enabled. */
export function admitMaxGroupChat(
  account: ResolvedMaxAccount,
  config: OpenClawConfig,
  chatId: number | string | undefined,
): MaxAdmission {
  const groupPolicy = resolveMaxGroupPolicy(account, config);
  if (groupPolicy === 'disabled') return { admitted: false, reason: 'groupPolicy=disabled' };
  if (groupPolicy === 'allowlist') {
    const groups = account.config.groups ?? {};
    if (!(String(chatId) in groups) && !('*' in groups)) {
      return { admitted: false, reason: 'chat is not in the groups allowlist' };
    }
  }
  // groups.<id>.enabled=false (else the "*" entry's) turns the group off under any policy.
  const groupCfg = account.config.groups?.[String(chatId)] ?? account.config.groups?.['*'];
  if (groupCfg?.enabled === false) return { admitted: false, reason: 'group enabled=false' };
  return { admitted: true };
}

/**
 * Sender allowlist of a group: its own groups.<id>.allowFrom (else the "*"
 * entry's), else the account's groupAllowFrom — the first non-empty one, as
 * core resolves group sender lists. `max:` prefixes are stripped.
 */
export function resolveMaxGroupSenderAllowFrom(
  account: ResolvedMaxAccount,
  chatId: number | string | undefined,
): string[] {
  const groupCfg = account.config.groups?.[String(chatId)] ?? account.config.groups?.['*'];
  const groupAllowFrom = Array.isArray(groupCfg?.allowFrom)
    ? (groupCfg.allowFrom as Array<string | number>)
    : undefined;
  return resolveGroupAllowFromSources({
    groupAllowFrom,
    allowFrom: account.config.groupAllowFrom,
  }).map((entry) => entry.replace(/^max:/i, ''));
}

/**
 * Whether a sender may trigger the bot in a group the group policy admits:
 * anyone when no sender list is set (unlike core's WhatsApp/Telegram, no
 * fallback to the DM allowFrom — MAX never applied it to groups), "*" for
 * anyone, else only the listed user ids. DM pairing approvals don't count.
 */
export function admitMaxGroupSender(
  account: ResolvedMaxAccount,
  chatId: number | string | undefined,
  senderId: number | string | undefined,
): MaxAdmission {
  const entries = resolveMaxGroupSenderAllowFrom(account, chatId);
  const allow = {
    entries,
    hasWildcard: entries.includes('*'),
    hasEntries: entries.length > 0,
  };
  if (isSenderIdAllowed(allow, senderId != null ? String(senderId) : undefined, true)) {
    return { admitted: true };
  }
  return { admitted: false, reason: 'sender is not in the group allowFrom/groupAllowFrom' };
}

/** Group policy, then the group's sender allowlist. */
export function admitMaxGroupMessage(
  account: ResolvedMaxAccount,
  config: OpenClawConfig,
  chatId: number | string | undefined,
  senderId: number | string | undefined,
): MaxAdmission {
  const chat = admitMaxGroupChat(account, config, chatId);
  return chat.admitted ? admitMaxGroupSender(account, chatId, senderId) : chat;
}

/** allowFrom from the config plus the approved pairing store, as strings. */
export async function readMaxDmAllowFrom(account: ResolvedMaxAccount): Promise<string[]> {
  const configAllowFrom = (account.config.allowFrom ?? []).map(String);
  const storeAllowFrom = await getMaxRuntime()
    .channel.pairing.readAllowFromStore({ channel: 'max', accountId: account.accountId })
    .catch(() => []);
  return [...configAllowFrom, ...storeAllowFrom];
}

/** Whether a DM peer passes the DM policy (disabled / open / allowFrom + pairing store). */
export async function admitMaxDmUser(
  account: ResolvedMaxAccount,
  userId: number | string | undefined,
): Promise<MaxAdmission> {
  const dmPolicy = account.config.dmPolicy ?? 'pairing';
  if (dmPolicy === 'disabled') return { admitted: false, reason: 'dmPolicy=disabled' };
  if (dmPolicy === 'open') return { admitted: true };
  const allowFrom = await readMaxDmAllowFrom(account);
  if (allowFrom.includes('*') || (userId != null && allowFrom.includes(String(userId)))) {
    return { admitted: true };
  }
  return {
    admitted: false,
    reason: `user is not in allowFrom or the pairing store (dmPolicy=${dmPolicy})`,
  };
}

/**
 * Start-up warning for a named account that sets no DM or group policy of its
 * own and inherits an open one (channels.max, or channels.defaults for
 * groups): the second bot is then open too. Names the account, the policy
 * and where to set its own; no secrets or user ids. undefined when nothing
 * open is inherited.
 */
export function describeMaxInheritedOpenAccess(
  cfg: OpenClawConfig | undefined,
  account: ResolvedMaxAccount,
): string | undefined {
  if (!cfg || account.accountId === DEFAULT_ACCOUNT_ID) return undefined;
  const channel = cfg.channels?.max as Record<string, unknown> | undefined;
  const accounts = channel?.accounts as Record<string, Record<string, unknown>> | undefined;
  const own = accounts?.[account.accountId] ?? {};
  const inherited: string[] = [];
  const fix: string[] = [];
  if (!Object.hasOwn(own, 'dmPolicy') && account.config.dmPolicy === 'open') {
    inherited.push('dmPolicy="open" from channels.max (anyone can message this bot)');
    fix.push('dmPolicy (e.g. "pairing")');
  }
  if (!Object.hasOwn(own, 'groupPolicy') && resolveMaxGroupPolicy(account, cfg) === 'open') {
    const from = channel?.groupPolicy === 'open' ? 'channels.max' : 'channels.defaults';
    inherited.push(`groupPolicy="open" from ${from} (any group can add and ping this bot)`);
    fix.push('groupPolicy (e.g. "allowlist" with groups)');
  }
  if (inherited.length === 0) return undefined;
  const path = maxAccountConfigPath(account.accountId);
  return (
    `MAX account "${account.accountId}" has no access policy of its own and inherits ` +
    `${inherited.join(' and ')}; set ${fix.map((key) => `${path}.${key}`).join(' / ')} ` +
    'to give this bot its own access rules.'
  );
}
