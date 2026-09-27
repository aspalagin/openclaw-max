/**
 * SecretRef contract of the MAX channel. `secretTargetRegistryEntries` tells
 * `openclaw secrets configure/apply/audit` which options may hold a SecretRef;
 * `collectRuntimeConfigAssignments` tells the gateway which of them each
 * account uses, so it resolves them into the runtime snapshot before the
 * account starts and isolates an account whose ref does not resolve (owner
 * `max:<accountId>`). Loaded from `secret-contract-api.js` before the plugin
 * runtime: keep this module free of runtime imports.
 */

import {
  collectSecretInputAssignment,
  createChannelSecretTargetRegistryEntries,
  getChannelRecord,
  hasOwnProperty,
  isEnabledFlag,
  isRecord,
  type ResolverContext,
  type SecretDefaults,
} from 'openclaw/plugin-sdk/channel-secret-basic-runtime';
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from 'openclaw/plugin-sdk/core';

/** Options accepting a SecretRef, at the channel level and under accounts.<id>. */
export const MAX_SECRET_FIELDS = ['botToken', 'webhookSecret', 'httpProxy'] as const;
export type MaxSecretField = (typeof MAX_SECRET_FIELDS)[number];

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: 'max',
  account: [...MAX_SECRET_FIELDS],
  channel: [...MAX_SECRET_FIELDS],
});

interface MaxAccountEntry {
  /** Config key under channels.max.accounts */
  key: string;
  accountId: string;
  account: Record<string, unknown>;
  enabled: boolean;
}

/** Webhook mode as resolveMaxTransport decides it (transport, else webhookUrl). */
function usesWebhook(config: Record<string, unknown>): boolean {
  if (config.transport === 'polling' || config.transport === 'webhook') {
    return config.transport === 'webhook';
  }
  return typeof config.webhookUrl === 'string' && config.webhookUrl.trim().length > 0;
}

/**
 * Whether an account reads the option at all: the token always, the webhook
 * secret only in webhook mode, the proxy always. `config` holds the account's
 * own transport/webhookUrl (both are per-bot keys, never inherited).
 */
function usesField(field: MaxSecretField, config: Record<string, unknown>): boolean {
  return field === 'webhookSecret' ? usesWebhook(config) : true;
}

/** The default account exists as listMaxAccountIds decides it. */
function hasDefaultAccount(
  channel: Record<string, unknown>,
  named: MaxAccountEntry[],
  env: NodeJS.ProcessEnv,
): boolean {
  if (channel.botToken || channel.tokenFile || env.MAX_BOT_TOKEN) return true;
  return named.length === 0 && channel.enabled !== false;
}

function listNamedAccounts(channel: Record<string, unknown>): MaxAccountEntry[] {
  const accounts = channel.accounts;
  if (!isRecord(accounts)) return [];
  const entries: MaxAccountEntry[] = [];
  for (const [key, account] of Object.entries(accounts)) {
    if (!isRecord(account)) continue;
    const accountId = normalizeAccountId(key);
    if (accountId === DEFAULT_ACCOUNT_ID) continue;
    entries.push({
      key,
      accountId,
      account,
      enabled: isEnabledFlag(channel) && isEnabledFlag(account),
    });
  }
  return entries;
}

/**
 * Register every SecretRef the enabled MAX accounts read. A channel-level
 * value belongs to the default account and, for httpProxy only, to each named
 * account that does not set its own; the other options are per-bot.
 */
export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const channel = getChannelRecord(params.config, 'max');
  if (!channel) return;
  // The owner contract: every non-secret channel setting the accounts use.
  const channelDefaults = Object.fromEntries(
    Object.entries(channel).filter(([key]) => key !== 'accounts'),
  );
  const named = listNamedAccounts(channel);
  const defaultActive =
    isEnabledFlag(channel) && hasDefaultAccount(channel, named, params.context.env);

  for (const field of MAX_SECRET_FIELDS) {
    const consumers: Array<{ accountId: string; account: Record<string, unknown> }> = [];
    if (defaultActive && usesField(field, channel)) {
      consumers.push({ accountId: DEFAULT_ACCOUNT_ID, account: {} });
    }
    if (field === 'httpProxy') {
      for (const entry of named) {
        if (entry.enabled && !hasOwnProperty(entry.account, field)) consumers.push(entry);
      }
    }
    const applyChannel = (value: unknown) => {
      channel[field] = value;
    };
    const channelPath = `channels.max.${field}`;
    if (consumers.length === 0) {
      collectSecretInputAssignment({
        value: channel[field],
        path: channelPath,
        expected: 'string',
        defaults: params.defaults,
        context: params.context,
        active: false,
        inactiveReason: `no enabled MAX account uses this channel-level ${field}.`,
        apply: applyChannel,
      });
    }
    const contract = { channel: channelDefaults, consumers: consumers.map((c) => c.accountId) };
    for (const consumer of consumers) {
      collectSecretInputAssignment({
        value: channel[field],
        path: channelPath,
        expected: 'string',
        defaults: params.defaults,
        context: params.context,
        owner: {
          ownerKind: 'account',
          ownerId: `max:${consumer.accountId}`,
          requiredForGateway: false,
          disposition: 'isolate',
          contract,
        },
        apply: applyChannel,
      });
    }

    for (const entry of named) {
      if (!hasOwnProperty(entry.account, field)) continue;
      collectSecretInputAssignment({
        value: entry.account[field],
        path: `channels.max.accounts.${entry.key}.${field}`,
        expected: 'string',
        defaults: params.defaults,
        context: params.context,
        active: entry.enabled && usesField(field, entry.account),
        inactiveReason:
          field === 'webhookSecret'
            ? 'MAX account is disabled or does not use webhook mode.'
            : 'MAX account is disabled.',
        owner: {
          ownerKind: 'account',
          ownerId: `max:${entry.accountId}`,
          requiredForGateway: false,
          disposition: 'isolate',
          contract: { channel: channelDefaults, account: entry.account },
        },
        apply: (value) => {
          entry.account[field] = value;
        },
      });
    }
  }
}

/** Channel secrets adapter (ChannelPlugin.secrets) and secret-contract-api.js export. */
export const maxChannelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
