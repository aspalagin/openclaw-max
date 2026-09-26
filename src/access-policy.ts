/**
 * Chat admission rules shared by the inbound gate and message-tool action
 * scoping: the DM policy with allowFrom and the pairing store, the group
 * policy with its allowlist.
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';

import type { ResolvedMaxAccount } from './accounts.js';
import { getMaxRuntime } from './runtime.js';

export type MaxAdmission = { admitted: true } | { admitted: false; reason: string };

/** Effective group policy: account, then channels.defaults, then allowlist. */
export function resolveMaxGroupPolicy(account: ResolvedMaxAccount, config: OpenClawConfig): string {
  return account.config.groupPolicy ?? config.channels?.defaults?.groupPolicy ?? 'allowlist';
}

/** Whether a group chat passes the group policy (disabled / allowlist with "*" / open). */
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
  return { admitted: true };
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
