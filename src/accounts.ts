/**
 * MAX account resolution — reads config and produces a resolved account object.
 */

import { lstatSync, readFileSync } from 'node:fs';

import { mergeAccountConfig } from 'openclaw/plugin-sdk/account-core';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from 'openclaw/plugin-sdk/core';

import {
  bindMaxNetwork,
  type MaxNetwork,
  MaxNetworkConfigError,
  resolveMaxNetwork,
} from './network.js';

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
  /** Update transport; default: "webhook" when webhookUrl is set, otherwise "polling" */
  transport?: 'polling' | 'webhook';
  webhookUrl?: string;
  webhookSecret?: string;
  /** File holding the webhook secret (like tokenFile) */
  webhookSecretFile?: string;
  webhookPath?: string;
  mediaMaxMb?: number;
  streamMode?: 'off' | 'partial' | 'block';
  /** Send mark_seen read receipts on inbound messages (default true) */
  markSeen?: boolean;
  /** Chats message-tool actions may act in (default "admitted"; see action-scope.ts) */
  actionScope?: 'admitted' | 'current' | 'off';
  /** Default MAX `notify` of sent messages (default true); channels always notify */
  notify?: boolean;
  /** Default: send messages without link previews (MAX `disable_link_preview`) */
  disableLinkPreview?: boolean;
  /** Most media attachments downloaded per inbound message (default 12) */
  mediaMaxCount?: number;
  /** MAX Bot API base URL (default https://platform-api2.max.ru); see network.ts */
  apiBaseUrl?: string;
  /** HTTP(S) proxy for all MAX traffic of the account; may carry credentials */
  httpProxy?: string;
}

export interface ResolvedMaxAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  token: string;
  tokenSource: 'config' | 'env' | 'file' | 'none';
  /**
   * Account settings; a named account inherits every channel-level value it
   * does not set itself, except MAX_ACCOUNT_OWN_KEYS.
   */
  config: MaxAccountConfig;
}

/**
 * Channel-level keys a named account never inherits: they belong to one bot
 * (token, token file, display name) or to one webhook subscription (transport,
 * URL, secret, secret file, HTTP path — a shared path would route two bots to
 * one handler). Top-level-only keys (commands, defaultAccount) are not account
 * settings at all.
 */
export const MAX_ACCOUNT_OWN_KEYS = [
  'botToken',
  'tokenFile',
  'name',
  'transport',
  'webhookUrl',
  'webhookSecret',
  'webhookSecretFile',
  'webhookPath',
  'commands',
  'defaultAccount',
] as const;

/**
 * Get the MAX channel section from config.
 */
function getMaxSection(cfg: OpenClawConfig): Record<string, unknown> | undefined {
  return (cfg.channels as Record<string, unknown>)?.max as Record<string, unknown> | undefined;
}

/** Read a secret from a regular (non-symlink) file; "" when missing or unreadable. */
export function readSecretFile(filePath?: string): string {
  return readTokenFile(filePath);
}

function readTokenFile(tokenFile?: string): string {
  const filePath = tokenFile?.trim();
  if (!filePath) return '';
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return '';
    return readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
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
export function resolveDefaultMaxAccountId(_cfg: OpenClawConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

/** Config path of an account's own settings, for error messages. */
export function maxAccountConfigPath(accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID ? 'channels.max' : `channels.max.accounts.${accountId}`;
}

/**
 * The account's validated network settings (API base URL, proxy). Throws
 * MaxNetworkConfigError with the config path; never echoes proxy credentials.
 */
export function resolveMaxAccountNetwork(account: ResolvedMaxAccount): MaxNetwork {
  return resolveMaxNetwork(account.config, maxAccountConfigPath(account.accountId));
}

function resolveAccountNetwork(
  accountId: string,
  config: MaxAccountConfig,
): MaxNetwork | { error: MaxNetworkConfigError } {
  try {
    return resolveMaxNetwork(config, maxAccountConfigPath(accountId));
  } catch (err) {
    if (err instanceof MaxNetworkConfigError) return { error: err };
    throw err;
  }
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
  let token = '';
  let tokenSource: ResolvedMaxAccount['tokenSource'] = 'none';

  if (accountId === DEFAULT_ACCOUNT_ID) {
    // Default account: top-level config
    accountConfig = {
      enabled: section.enabled !== false,
      botToken: section.botToken as string | undefined,
      tokenFile: section.tokenFile as string | undefined,
      name: section.name as string | undefined,
      dmPolicy: section.dmPolicy as string | undefined,
      allowFrom: section.allowFrom as Array<string | number> | undefined,
      groups: section.groups as MaxAccountConfig['groups'],
      groupPolicy: section.groupPolicy as string | undefined,
      groupAllowFrom: section.groupAllowFrom as Array<string | number> | undefined,
      transport: section.transport as MaxAccountConfig['transport'],
      webhookUrl: section.webhookUrl as string | undefined,
      webhookSecret: section.webhookSecret as string | undefined,
      webhookSecretFile: section.webhookSecretFile as string | undefined,
      webhookPath: section.webhookPath as string | undefined,
      mediaMaxMb: section.mediaMaxMb as number | undefined,
      streamMode: section.streamMode as MaxAccountConfig['streamMode'],
      markSeen: section.markSeen as boolean | undefined,
      actionScope: section.actionScope as MaxAccountConfig['actionScope'],
      notify: section.notify as boolean | undefined,
      disableLinkPreview: section.disableLinkPreview as boolean | undefined,
      mediaMaxCount: section.mediaMaxCount as number | undefined,
      apiBaseUrl: section.apiBaseUrl as string | undefined,
      httpProxy: section.httpProxy as string | undefined,
    };

    if (accountConfig.botToken?.trim()) {
      token = accountConfig.botToken.trim();
      tokenSource = 'config';
    } else if (accountConfig.tokenFile?.trim()) {
      token = readTokenFile(accountConfig.tokenFile);
      tokenSource = token ? 'file' : 'none';
    }
    if (!token && process.env.MAX_BOT_TOKEN?.trim()) {
      token = process.env.MAX_BOT_TOKEN.trim();
      tokenSource = 'env';
    }
  } else {
    // Named account: the account's own values over the channel-level ones
    // (SDK mergeAccountConfig, as core channels do), minus the per-bot keys.
    // A channel switched off switches off every account.
    const raw = accounts?.[accountId] ?? {};
    accountConfig = {
      ...mergeAccountConfig<Record<string, unknown>>({
        channelConfig: section,
        accountConfig: raw,
        omitKeys: [...MAX_ACCOUNT_OWN_KEYS],
      }),
      enabled: section.enabled !== false && raw.enabled !== false,
    } as MaxAccountConfig;

    if (accountConfig.botToken?.trim()) {
      token = accountConfig.botToken.trim();
      tokenSource = 'config';
    } else if (accountConfig.tokenFile?.trim()) {
      token = readTokenFile(accountConfig.tokenFile);
      tokenSource = token ? 'file' : 'none';
    }
  }

  // Every MaxApi built for this token (any send/action/lifecycle path) uses
  // the account's API base URL and proxy — or fails with their config error.
  bindMaxNetwork(token, resolveAccountNetwork(accountId, accountConfig));

  return {
    accountId,
    name: accountConfig.name,
    enabled: accountConfig.enabled ?? true,
    token,
    tokenSource,
    config: accountConfig,
  };
}
