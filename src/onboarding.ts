/**
 * MAX channel onboarding — setup wizard for `openclaw channel add max`
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "openclaw/plugin-sdk/core";
import {
  formatDocsLink,
} from "openclaw/plugin-sdk/setup";
import type { DmPolicy } from "openclaw/plugin-sdk/config-runtime";
import type {
  ChannelSetupWizard,
  ChannelSetupDmPolicy,
} from "openclaw/plugin-sdk/setup";
import {
  listMaxAccountIds,
  resolveDefaultMaxAccountId,
  resolveMaxAccount,
} from "./accounts.js";
import { MaxApi } from "./api.js";

const channel = "max" as const;

const ENV_MAX_BOT_TOKEN = "MAX_BOT_TOKEN";

function setMaxDmPolicy(cfg: OpenClawConfig, policy: DmPolicy): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      max: {
        ...cfg.channels?.["max"],
        dmPolicy: policy,
      },
    },
  };
}

const dmPolicy: ChannelSetupDmPolicy = {
  label: "MAX",
  channel,
  policyKey: "channels.max.dmPolicy",
  allowFromKey: "channels.max.allowFrom",
  getCurrent: (cfg: OpenClawConfig) => cfg.channels?.["max"]?.dmPolicy ?? "pairing",
  setPolicy: (cfg: OpenClawConfig, policy: DmPolicy) => setMaxDmPolicy(cfg, policy),
};

function applyAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  const { cfg, accountId, patch } = params;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        max: {
          ...cfg.channels?.["max"],
          enabled: true,
          ...patch,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      max: {
        ...cfg.channels?.["max"],
        enabled: true,
        accounts: {
          ...cfg.channels?.["max"]?.accounts,
          [accountId]: {
            ...cfg.channels?.["max"]?.accounts?.[accountId],
            enabled: true,
            ...patch,
          },
        },
      },
    },
  };
}

export const maxSetupWizard: ChannelSetupWizard = {
  channel,

  status: {
    configuredLabel: "MAX (configured)",
    unconfiguredLabel: "MAX Messenger",
    configuredHint: "configured",
    unconfiguredHint: "needs bot token",
    resolveConfigured: ({ cfg }) => {
      return listMaxAccountIds(cfg).some(
        (accountId) => resolveMaxAccount({ cfg, accountId }).tokenSource !== "none",
      );
    },
    resolveStatusLines: ({ cfg, configured }) => {
      return [`MAX: ${configured ? "configured" : "needs bot token"}`];
    },
  },

  introNote: {
    title: "MAX setup",
    lines: [
      "MAX messenger bot requires a bot token from https://platform-api.max.ru",
      "Create your bot via MAX Business or MAX API portal.",
      "The bot can receive messages via polling (default) or webhook.",
      `Docs: ${formatDocsLink("/channels/max", "channels/max")}`,
    ],
  },

  envShortcut: {
    prompt: "Use MAX_BOT_TOKEN env var?",
    preferredEnvVar: ENV_MAX_BOT_TOKEN,
    isAvailable: ({ accountId }) => {
      return accountId === DEFAULT_ACCOUNT_ID && Boolean(process.env[ENV_MAX_BOT_TOKEN]);
    },
    apply: ({ cfg, accountId }) => {
      return applyAccountConfig({ cfg, accountId, patch: {} });
    },
  },

  credentials: [
    {
      inputKey: "botToken",
      providerHint: "MAX bot token",
      credentialLabel: "bot token",
      preferredEnvVar: ENV_MAX_BOT_TOKEN,
      envPrompt: "Use MAX_BOT_TOKEN env var?",
      keepPrompt: "Keep current bot token?",
      inputPrompt: "MAX bot token",

      inspect: ({ cfg, accountId }) => {
        const account = resolveMaxAccount({ cfg, accountId });
        const hasToken = Boolean(account.token);
        const envValue = accountId === DEFAULT_ACCOUNT_ID ? process.env[ENV_MAX_BOT_TOKEN] : undefined;

        return {
          accountConfigured: hasToken,
          hasConfiguredValue: hasToken,
          resolvedValue: account.token || undefined,
          envValue,
        };
      },

      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,

      applyUseEnv: ({ cfg, accountId }) => {
        return applyAccountConfig({ cfg, accountId, patch: {} });
      },

      applySet: async ({ cfg, accountId, value, resolvedValue }) => {
        const tokenValue = String(resolvedValue).trim();

        // Verify token by calling GET /me
        try {
          const api = new MaxApi({ token: tokenValue, timeoutMs: 5000 });
          const me = await api.getMe();
          console.log(`✓ Token verified! Bot: ${me.first_name}${me.username ? ` (@${me.username})` : ""} (ID: ${me.user_id})`);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.warn(`⚠ Token verification failed: ${errorMsg}`);
          // Continue anyway - user will see the error when gateway starts
        }

        return applyAccountConfig({
          cfg,
          accountId,
          patch: { botToken: tokenValue },
        });
      },
    },
  ],

  textInputs: [
    {
      inputKey: "tokenFile",
      message: "Token file path (optional)",
      placeholder: "/path/to/max-token.txt",
      required: false,

      shouldPrompt: ({ cfg, accountId, credentialValues }) => {
        // Only prompt if no token was set via credential
        return !credentialValues.botToken;
      },

      applySet: ({ cfg, accountId, value }) => {
        const path = value.trim();
        if (!path) return cfg;

        return applyAccountConfig({
          cfg,
          accountId,
          patch: { tokenFile: path },
        });
      },
    },
  ],

  finalize: ({ cfg, accountId }) => {
    // Ensure the channel is enabled
    return {
      cfg: {
        ...cfg,
        channels: {
          ...cfg.channels,
          max: {
            ...cfg.channels?.["max"],
            enabled: true,
          },
        },
      },
    };
  },

  dmPolicy,
};
