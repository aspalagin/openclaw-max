/**
 * MAX account resolution — reads config and produces a resolved account object.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/core";

export interface MaxAccountConfig {
  enabled?: boolean;
  botToken?: string;
  tokenFile?: string;
  name?: string;
  dmPolicy?: string;
  allowFrom?: Array<string | number>;
  groups?: Record<string, { requireMention?: boolean; [key: string]: unknown }>;
  groupPolicy?: string;
  groupAllowFrom?: Array<string | number>;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPath?: string;
  mediaMaxMb?: number;
  streamMode?: "off" | "partial" | "block";
}

export interface ResolvedMaxAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  token: string;
  tokenSource: "config" | "env" | "file" | "none";
  config: MaxAccountConfig;
}

/**
 * Get the MAX channel section from config.
 */
function getMaxSection(cfg: OpenClawConfig): Record<string, unknown> | undefined {
  return (cfg.channels as Record<string, unknown>)?.max as Record<string, unknown> | undefined;
}

/**
 * List all MAX account IDs from config.
 */
export function listMaxAccountIds(cfg: OpenClawConfig): string[] {
  const section = getMaxSection(cfg);
  if (!section) return [];

  const ids: string[] = [];
  // Check for default account (top-level botToken)
  const hasDefault = section.botToken || section.tokenFile || process.env.MAX_BOT_TOKEN;
  if (hasDefault) ids.push(DEFAULT_ACCOUNT_ID);

  // Check for named accounts
  const accounts = section.accounts as Record<string, unknown> | undefined;
  if (accounts) {
    for (const key of Object.keys(accounts)) {
      const normalized = normalizeAccountId(key);
      if (normalized !== DEFAULT_ACCOUNT_ID && !ids.includes(normalized)) {
        ids.push(normalized);
      }
    }
  }

  // If section exists but no token sources found, still return default
  if (ids.length === 0 && section.enabled !== false) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }

  return ids;
}

/**
 * Resolve the default account ID.
 */
export function resolveDefaultMaxAccountId(cfg: OpenClawConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve a single MAX account from config.
 */
export function resolveMaxAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedMaxAccount {
  const { cfg, accountId: rawId } = params;
  const accountId = rawId ? normalizeAccountId(rawId) : DEFAULT_ACCOUNT_ID;
  const section = getMaxSection(cfg) ?? {};
  const accounts = section.accounts as Record<string, Record<string, unknown>> | undefined;

  let accountConfig: MaxAccountConfig;
  let token = "";
  let tokenSource: ResolvedMaxAccount["tokenSource"] = "none";

  if (accountId === DEFAULT_ACCOUNT_ID) {
    // Default account: top-level config
    accountConfig = {
      enabled: section.enabled !== false,
      botToken: section.botToken as string | undefined,
      tokenFile: section.tokenFile as string | undefined,
      name: section.name as string | undefined,
      dmPolicy: section.dmPolicy as string | undefined,
      allowFrom: section.allowFrom as Array<string | number> | undefined,
      groups: section.groups as MaxAccountConfig["groups"],
      groupPolicy: section.groupPolicy as string | undefined,
      groupAllowFrom: section.groupAllowFrom as Array<string | number> | undefined,
      webhookUrl: section.webhookUrl as string | undefined,
      webhookSecret: section.webhookSecret as string | undefined,
      webhookPath: section.webhookPath as string | undefined,
      mediaMaxMb: section.mediaMaxMb as number | undefined,
      streamMode: section.streamMode as MaxAccountConfig["streamMode"],
    };

    if (accountConfig.botToken?.trim()) {
      token = accountConfig.botToken.trim();
      tokenSource = "config";
    } else if (process.env.MAX_BOT_TOKEN?.trim()) {
      token = process.env.MAX_BOT_TOKEN.trim();
      tokenSource = "env";
    }
  } else {
    // Named account
    const raw = accounts?.[accountId] ?? {};
    accountConfig = {
      enabled: raw.enabled !== false,
      botToken: raw.botToken as string | undefined,
      name: raw.name as string | undefined,
      dmPolicy: raw.dmPolicy as string | undefined,
      allowFrom: raw.allowFrom as Array<string | number> | undefined,
      groups: raw.groups as MaxAccountConfig["groups"],
      groupPolicy: raw.groupPolicy as string | undefined,
      groupAllowFrom: raw.groupAllowFrom as Array<string | number> | undefined,
      webhookUrl: raw.webhookUrl as string | undefined,
      webhookSecret: raw.webhookSecret as string | undefined,
      webhookPath: raw.webhookPath as string | undefined,
      mediaMaxMb: raw.mediaMaxMb as number | undefined,
      streamMode: raw.streamMode as MaxAccountConfig["streamMode"],
    };

    if (accountConfig.botToken?.trim()) {
      token = accountConfig.botToken.trim();
      tokenSource = "config";
    }
  }

  return {
    accountId,
    name: accountConfig.name,
    enabled: accountConfig.enabled ?? true,
    token,
    tokenSource,
    config: accountConfig,
  };
}
