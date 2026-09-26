/**
 * Access policy of the MAX channel: DM pairing/allowlist, group
 * requireMention and tool policy, security warnings, pairing approval.
 */

import type { ChannelPlugin } from 'openclaw/plugin-sdk/channel-core';
import type { GroupToolPolicyConfig } from 'openclaw/plugin-sdk/channel-policy';
import { resolveToolsBySender } from 'openclaw/plugin-sdk/channel-policy';
import { PAIRING_APPROVED_MESSAGE } from 'openclaw/plugin-sdk/channel-status';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { DEFAULT_ACCOUNT_ID, formatPairingApproveHint } from 'openclaw/plugin-sdk/core';

import { type ResolvedMaxAccount, resolveMaxAccount } from './accounts.js';
import { sendMaxMessage } from './send.js';

type MaxChannelPlugin = ChannelPlugin<ResolvedMaxAccount>;

// ── MAX group policy helpers ──
// These mirror resolveChannelGroupRequireMention/resolveChannelGroupToolsPolicy
// (internal SDK functions not exported) but for the "max" channel.

function resolveMaxGroupConfig(
  cfg: OpenClawConfig,
  groupId?: string | null,
  accountId?: string | null,
) {
  const maxSection = (cfg.channels as Record<string, unknown>)?.max as
    Record<string, unknown> | undefined;
  if (!maxSection) return { groupConfig: undefined, defaultConfig: undefined };

  // Resolve groups map: account-level takes priority over channel-level
  let groups: Record<string, unknown> | undefined;
  if (accountId && accountId !== DEFAULT_ACCOUNT_ID) {
    const accounts = maxSection.accounts as Record<string, Record<string, unknown>> | undefined;
    groups = accounts?.[accountId]?.groups as Record<string, unknown> | undefined;
  }
  if (!groups) {
    groups = maxSection.groups as Record<string, unknown> | undefined;
  }

  const normalizedId = groupId?.trim();
  const groupConfig =
    normalizedId && groups
      ? (groups[normalizedId] as Record<string, unknown> | undefined)
      : undefined;
  const defaultConfig = groups?.['*'] as Record<string, unknown> | undefined;

  return { groupConfig, defaultConfig };
}

function resolveMaxGroupRequireMention(params: {
  cfg: OpenClawConfig;
  groupId?: string | null;
  accountId?: string | null;
}): boolean {
  const { groupConfig, defaultConfig } = resolveMaxGroupConfig(
    params.cfg,
    params.groupId,
    params.accountId,
  );
  const configMention =
    typeof groupConfig?.requireMention === 'boolean'
      ? groupConfig.requireMention
      : typeof defaultConfig?.requireMention === 'boolean'
        ? defaultConfig.requireMention
        : undefined;
  if (typeof configMention === 'boolean') return configMention;
  return true; // default: require mention
}

function resolveMaxGroupToolPolicy(params: {
  cfg: OpenClawConfig;
  groupId?: string | null;
  accountId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
}): GroupToolPolicyConfig | undefined {
  const { groupConfig, defaultConfig } = resolveMaxGroupConfig(
    params.cfg,
    params.groupId,
    params.accountId,
  );

  // Group-level sender-specific policy
  const groupSenderPolicy = resolveToolsBySender({
    toolsBySender: groupConfig?.toolsBySender as Record<string, GroupToolPolicyConfig> | undefined,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  if (groupSenderPolicy) return groupSenderPolicy;
  if (groupConfig?.tools) return groupConfig.tools as GroupToolPolicyConfig;

  // Default config fallback
  const defaultSenderPolicy = resolveToolsBySender({
    toolsBySender: defaultConfig?.toolsBySender as
      Record<string, GroupToolPolicyConfig> | undefined,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  if (defaultSenderPolicy) return defaultSenderPolicy;
  if (defaultConfig?.tools) return defaultConfig.tools as GroupToolPolicyConfig;

  return undefined;
}

/** DM policy (default pairing) and warnings for open group policy. */
export const maxSecurityAdapter: NonNullable<MaxChannelPlugin['security']> = {
  resolveDmPolicy: ({ cfg, accountId, account }) => {
    const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
    const maxSection = (cfg.channels as Record<string, unknown>)?.max as
      Record<string, unknown> | undefined;
    const useAccountPath = Boolean(
      (maxSection?.accounts as Record<string, unknown>)?.[resolvedAccountId],
    );
    const basePath = useAccountPath
      ? `channels.max.accounts.${resolvedAccountId}.`
      : 'channels.max.';
    return {
      policy: account.config.dmPolicy ?? 'pairing',
      allowFrom: account.config.allowFrom ?? [],
      policyPath: `${basePath}dmPolicy`,
      allowFromPath: basePath,
      approveHint: formatPairingApproveHint('max'),
      normalizeEntry: (raw: string) => raw.replace(/^max:/i, ''),
    };
  },
  collectWarnings: ({ account, cfg }) => {
    const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
    const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? 'allowlist';
    if (groupPolicy !== 'open') {
      return [];
    }
    const groupAllowlistConfigured =
      account.config.groups && Object.keys(account.config.groups).length > 0;
    if (groupAllowlistConfigured) {
      return [
        `- MAX groups: groupPolicy="open" allows any member in allowed groups to trigger (mention-gated). Set channels.max.groupPolicy="allowlist" + channels.max.groupAllowFrom to restrict senders.`,
      ];
    }
    return [
      `- MAX groups: groupPolicy="open" with no channels.max.groups allowlist; any group can add + ping (mention-gated). Set channels.max.groupPolicy="allowlist" + channels.max.groupAllowFrom or configure channels.max.groups.`,
    ];
  },
};

/** Group requireMention (default true) and tool policy from channels.max.groups. */
export const maxGroupsAdapter: NonNullable<MaxChannelPlugin['groups']> = {
  resolveRequireMention: ({ cfg, groupId, accountId }) =>
    resolveMaxGroupRequireMention({ cfg, groupId, accountId }),
  resolveToolPolicy: ({
    cfg,
    groupId,
    accountId,
    senderId,
    senderName,
    senderUsername,
    senderE164,
  }) =>
    resolveMaxGroupToolPolicy({
      cfg,
      groupId,
      accountId,
      senderId,
      senderName,
      senderUsername,
      senderE164,
    }),
};

/** Pairing ids are MAX user ids; approval is announced to the user in MAX. */
export const maxPairingAdapter: NonNullable<MaxChannelPlugin['pairing']> = {
  idLabel: 'maxUserId',
  normalizeAllowEntry: (entry) => entry.replace(/^max:/i, ''),
  notifyApproval: async ({ cfg, id }) => {
    const account = resolveMaxAccount({ cfg });
    if (!account.token) throw new Error('MAX bot token not configured');
    await sendMaxMessage(id, PAIRING_APPROVED_MESSAGE, { token: account.token });
  },
};
