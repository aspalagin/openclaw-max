/**
 * Account lifecycle of the MAX channel: gateway start (probe, bot commands,
 * monitor) and logout, status snapshots, probes and group audits (health).
 */

import type { ChannelPlugin } from 'openclaw/plugin-sdk/channel-core';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { DEFAULT_ACCOUNT_ID } from 'openclaw/plugin-sdk/core';

import { describeMaxInheritedOpenAccess } from './access-policy.js';
import {
  isMaxAccountConfigured,
  MaxSecretConfigError,
  type ResolvedMaxAccount,
  resolveMaxAccountNetwork,
} from './accounts.js';
import { MaxApi } from './api.js';
import { startMaxPolling } from './monitor.js';
import { DEFAULT_MAX_API_BASE_URL, redactProxyUrl } from './network.js';
import { writeMaxConfig } from './runtime.js';

type MaxChannelPlugin = ChannelPlugin<ResolvedMaxAccount>;

/** Runtime snapshots, GET /me probe and a membership audit of configured groups. */
export const maxStatusAdapter: NonNullable<MaxChannelPlugin['status']> = {
  defaultRuntime: {
    accountId: DEFAULT_ACCOUNT_ID,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  },

  buildChannelSummary: ({ snapshot }) => ({
    configured: snapshot.configured ?? false,
    tokenSource: snapshot.tokenSource ?? 'none',
    running: snapshot.running ?? false,
    // lifecycle/connected must mirror the gateway runtime store: the health cache
    // compares them with the live runtime and treats a missing value as stale.
    ...(snapshot.lifecycle !== undefined ? { lifecycle: snapshot.lifecycle } : {}),
    ...(typeof snapshot.connected === 'boolean' ? { connected: snapshot.connected } : {}),
    lastStartAt: snapshot.lastStartAt ?? null,
    lastStopAt: snapshot.lastStopAt ?? null,
    lastError: snapshot.lastError ?? null,
    probe: snapshot.probe,
  }),

  probeAccount: async ({ account, timeoutMs }) => {
    if (!account.token) return { ok: false, error: 'no token' };
    const api = new MaxApi({ token: account.token, timeoutMs });
    try {
      const me = await api.getMe();
      return { ok: true, bot: me };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },

  buildAccountSnapshot: ({ account, runtime, probe }) => ({
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: isMaxAccountConfigured(account),
    tokenSource: account.tokenSource,
    tokenStatus: account.tokenStatus,
    ...(account.stateReason ? { stateReason: account.stateReason } : {}),
    running: runtime?.running ?? false,
    ...(runtime?.lifecycle !== undefined ? { lifecycle: runtime.lifecycle } : {}),
    ...(typeof runtime?.connected === 'boolean' ? { connected: runtime.connected } : {}),
    lastStartAt: runtime?.lastStartAt ?? null,
    lastStopAt: runtime?.lastStopAt ?? null,
    lastError: runtime?.lastError ?? null,
    probe,
    lastInboundAt: runtime?.lastInboundAt ?? null,
    lastOutboundAt: runtime?.lastOutboundAt ?? null,
  }),

  auditAccount: async ({ account, timeoutMs }) => {
    if (!account.token) {
      return {
        ok: false,
        checkedGroups: 0,
        unresolvedGroups: 0,
        groups: [],
        elapsedMs: 0,
      };
    }

    const start = Date.now();
    const groups = account.config.groups ?? {};
    const groupIds = Object.keys(groups).filter((id) => id !== '*');

    if (groupIds.length === 0) {
      return {
        ok: true,
        checkedGroups: 0,
        unresolvedGroups: 0,
        groups: [],
        elapsedMs: Date.now() - start,
      };
    }

    const api = new MaxApi({ token: account.token, timeoutMs });
    const results: Array<{
      id: string;
      ok: boolean;
      title?: string;
      error?: string;
    }> = [];
    let unresolvedCount = 0;

    for (const groupId of groupIds) {
      try {
        const chat = await api.getChat(Number(groupId));
        const isMember = chat.type === 'chat' || chat.type === 'channel';
        if (!isMember) {
          unresolvedCount++;
          results.push({
            id: groupId,
            ok: false,
            error: 'Bot is not a member of this chat',
          });
        } else {
          // Long polling delivers group updates only to admin bots — surface
          // a missing-admin state, the classic "bot is silent in the group" cause.
          let adminSuffix = '';
          try {
            const membership = await api.getMembership(Number(groupId));
            if (membership && membership.is_admin !== true) {
              adminSuffix = ' (⚠ bot is not admin — group updates are not delivered via polling)';
            }
          } catch {
            // membership endpoint unavailable — skip the admin hint
          }
          results.push({
            id: groupId,
            ok: true,
            title: `${chat.title ?? ''}${adminSuffix}` || undefined,
          });
        }
      } catch (err) {
        unresolvedCount++;
        results.push({
          id: groupId,
          ok: false,
          error: String(err),
        });
      }
    }

    return {
      ok: unresolvedCount === 0,
      checkedGroups: groupIds.length,
      unresolvedGroups: unresolvedCount,
      groups: results,
      elapsedMs: Date.now() - start,
    };
  },

  collectStatusIssues: (accounts) => {
    const issues: Array<{
      channel: string;
      accountId: string;
      kind: 'config' | 'permissions' | 'auth' | 'runtime' | 'intent';
      message: string;
      fix?: string;
    }> = [];

    for (const snapshot of accounts) {
      if (!snapshot.configured) {
        issues.push({
          channel: 'max',
          accountId: snapshot.accountId,
          kind: 'config' as const,
          message: snapshot.stateReason
            ? `MAX bot token not configured: ${snapshot.stateReason}`
            : 'MAX bot token not configured',
          fix: 'Set channels.max.botToken or MAX_BOT_TOKEN env var',
        });
      }
    }

    return issues;
  },
};

/** Starts one account: probe the bot, register commands, run the monitor until abort. */
export const maxGatewayAdapter: NonNullable<MaxChannelPlugin['gateway']> = {
  startAccount: async (ctx) => {
    const account = ctx.account;
    // Path and ref only; the gateway normally isolates such an account itself.
    if (account.secretErrors?.botToken) {
      throw new MaxSecretConfigError(account.secretErrors.botToken);
    }
    // A named account open only through channel-level (or default) policies.
    const inheritedOpen = describeMaxInheritedOpenAccess(ctx.cfg, account);
    if (inheritedOpen) ctx.log?.warn(`[${account.accountId}] ${inheritedOpen}`);
    const token = account.token.trim();
    // A bad apiBaseUrl/httpProxy stops the account with a clear error rather
    // than letting it connect directly or to the wrong host.
    const network = resolveMaxAccountNetwork(account);
    const route =
      (network.apiBaseUrl !== DEFAULT_MAX_API_BASE_URL ? ` api=${network.apiBaseUrl}` : '') +
      (network.proxyUrl ? ` proxy=${redactProxyUrl(network.proxyUrl)}` : '');

    let botLabel = '';
    let botUserId: number | undefined;
    let botUsername: string | undefined;
    try {
      const probeApi = new MaxApi({ token, timeoutMs: 3000, network });
      const me = await probeApi.getMe();
      if (me.username) {
        botLabel = ` (@${me.username})`;
        botUsername = me.username;
      }
      botUserId = me.user_id;
    } catch {
      // probe failed, continue anyway
    }

    ctx.log?.info(`[${account.accountId}] Starting MAX provider${botLabel}${route}`);

    const api = new MaxApi({ token, network });

    // Register bot commands if configured
    const commands = ctx.cfg.channels?.max?.commands as
      Array<{ name: string; description?: string }> | undefined;
    if (commands?.length) {
      try {
        await api.setMyCommands(commands);
        ctx.log?.info(`[${account.accountId}] Registered ${commands.length} bot commands`);
      } catch (err) {
        ctx.log?.error(`[${account.accountId}] Failed to register commands: ${String(err)}`);
      }
    }

    return startMaxPolling({
      api,
      account,
      config: ctx.cfg,
      abortSignal: ctx.abortSignal,
      botUserId,
      botUsername,
      log: ctx.log,
      statusSink: (patch) => {
        const current = ctx.getStatus();
        ctx.setStatus({ ...current, ...patch });
      },
    });
  },

  logoutAccount: async ({ accountId, cfg }) => {
    const nextCfg = { ...cfg } as OpenClawConfig;
    const channels = { ...(nextCfg.channels as Record<string, unknown>) };
    const maxSection = channels.max ? { ...(channels.max as Record<string, unknown>) } : undefined;
    let cleared = false;

    if (maxSection) {
      if (accountId === DEFAULT_ACCOUNT_ID && maxSection.botToken) {
        delete maxSection.botToken;
        cleared = true;
      }

      const accounts = maxSection.accounts as Record<string, unknown> | undefined;
      if (accounts && accountId in accounts) {
        delete (accounts as Record<string, unknown>)[accountId];
        cleared = true;
      }

      channels.max = maxSection;
      nextCfg.channels = channels;

      if (cleared) {
        await writeMaxConfig(nextCfg);
      }
    }

    return { cleared, loggedOut: cleared };
  },
};
