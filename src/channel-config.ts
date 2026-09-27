/**
 * Account config and CLI setup adapters of the MAX channel: account listing
 * and resolution, enable/delete, allowFrom formatting, `openclaw channels add`.
 */

import type { ChannelPlugin } from 'openclaw/plugin-sdk/channel-core';
import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
} from 'openclaw/plugin-sdk/core';

import {
  isMaxAccountConfigured,
  listMaxAccountIds,
  type ResolvedMaxAccount,
  resolveMaxAccount,
} from './accounts.js';

type MaxChannelPlugin = ChannelPlugin<ResolvedMaxAccount>;

/** Accounts under channels.max (top level = default account, plus channels.max.accounts). */
export const maxConfigAdapter: NonNullable<MaxChannelPlugin['config']> = {
  listAccountIds: (cfg) => listMaxAccountIds(cfg),
  resolveAccount: (cfg, accountId) => resolveMaxAccount({ cfg, accountId }),
  defaultAccountId: () => DEFAULT_ACCOUNT_ID,

  setAccountEnabled: ({ cfg, accountId, enabled }) =>
    setAccountEnabledInConfigSection({
      cfg,
      sectionKey: 'max',
      accountId,
      enabled,
      allowTopLevel: true,
    }),

  deleteAccount: ({ cfg, accountId }) =>
    deleteAccountFromConfigSection({
      cfg,
      sectionKey: 'max',
      accountId,
      clearBaseFields: ['botToken', 'tokenFile', 'name'],
    }),

  // An unresolved SecretRef token counts as configured: startAccount then
  // fails with its config path instead of the account being silently skipped.
  isConfigured: (account) => isMaxAccountConfigured(account),

  describeAccount: (account) => ({
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: isMaxAccountConfigured(account),
    tokenSource: account.tokenSource,
    tokenStatus: account.tokenStatus,
  }),

  resolveAllowFrom: ({ cfg, accountId }) =>
    (resolveMaxAccount({ cfg, accountId }).config.allowFrom ?? []).map(String),

  formatAllowFrom: ({ allowFrom }) =>
    allowFrom
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map((entry) => entry.replace(/^max:/i, '')),
};

/** Non-interactive setup: token / token file / MAX_BOT_TOKEN for the default account. */
export const maxSetupAdapter: NonNullable<MaxChannelPlugin['setup']> = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),

  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: 'max',
      accountId,
      name,
    }),

  validateInput: ({ accountId, input }) => {
    if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      return 'MAX_BOT_TOKEN can only be used for the default account.';
    }
    if (!input.useEnv && !input.token && !input.tokenFile) {
      return 'MAX requires --token or --token-file (or --use-env with MAX_BOT_TOKEN).';
    }
    return null;
  },

  applyAccountConfig: ({ cfg, accountId, input }) => {
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: 'max',
      accountId,
      name: input.name,
    });
    const next =
      accountId !== DEFAULT_ACCOUNT_ID
        ? migrateBaseNameToDefaultAccount({
            cfg: namedConfig,
            channelKey: 'max',
          })
        : namedConfig;

    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...next,
        channels: {
          ...next.channels,
          max: {
            ...((next.channels as Record<string, unknown>)?.max as Record<string, unknown>),
            enabled: true,
            ...(input.useEnv ? {} : input.token ? { botToken: input.token } : {}),
          },
        },
      };
    }

    const maxSection =
      ((next.channels as Record<string, unknown>)?.max as Record<string, unknown>) ?? {};
    return {
      ...next,
      channels: {
        ...next.channels,
        max: {
          ...maxSection,
          enabled: true,
          accounts: {
            ...(maxSection.accounts as Record<string, unknown>),
            [accountId]: {
              ...((maxSection.accounts as Record<string, unknown>)?.[accountId] as Record<
                string,
                unknown
              >),
              enabled: true,
              ...(input.token ? { botToken: input.token } : {}),
            },
          },
        },
      },
    };
  },
};
