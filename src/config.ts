/**
 * MAX channel — account resolution helpers
 * Account types live in types.ts
 */
import type { MaxAccountConfig, MaxChannelConfig, ResolvedMaxAccount } from "./types.js";

export { ResolvedMaxAccount };

export const DEFAULT_ACCOUNT_ID = "default";

function getMaxChannelConfig(cfg: Record<string, unknown>): MaxChannelConfig | undefined {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  return channels?.max as MaxChannelConfig | undefined;
}

/**
 * List all configured MAX account IDs
 */
export function listMaxAccountIds(cfg: Record<string, unknown>): string[] {
  const maxCfg = getMaxChannelConfig(cfg);
  if (!maxCfg) return [];

  if (maxCfg.accounts && Object.keys(maxCfg.accounts).length > 0) {
    return Object.keys(maxCfg.accounts);
  }

  // Legacy: top-level botToken
  if (maxCfg.botToken) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return [];
}

/**
 * Resolve the default account ID
 */
export function resolveDefaultMaxAccountId(cfg: Record<string, unknown>): string {
  const maxCfg = getMaxChannelConfig(cfg);
  if (maxCfg?.defaultAccount) return maxCfg.defaultAccount;
  const ids = listMaxAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve a MAX account from config
 */
export function resolveMaxAccount(opts: {
  cfg: Record<string, unknown>;
  accountId?: string | null;
}): ResolvedMaxAccount {
  const accountId = opts.accountId ?? resolveDefaultMaxAccountId(opts.cfg);
  const maxCfg = getMaxChannelConfig(opts.cfg);

  let accountConfig: MaxAccountConfig = {};

  if (maxCfg?.accounts?.[accountId]) {
    accountConfig = maxCfg.accounts[accountId];
  } else if (accountId === DEFAULT_ACCOUNT_ID && maxCfg) {
    // Legacy single-account mode: read from top-level
    accountConfig = {
      enabled: maxCfg.enabled,
      botToken: maxCfg.botToken,
      allowFrom: maxCfg.allowFrom,
      dmPolicy: maxCfg.dmPolicy,
      streaming: maxCfg.streaming,
    };
  }

  const botToken = accountConfig.botToken ?? "";
  const configured = Boolean(botToken.trim());
  const enabled = maxCfg?.enabled !== false && accountConfig.enabled !== false;

  return {
    accountId,
    name: accountConfig.name,
    enabled,
    configured,
    botToken,
    config: accountConfig,
  };
}
