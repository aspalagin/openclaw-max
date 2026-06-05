/**
 * MAX channel plugin for OpenClaw.
 *
 * Implements the ChannelPlugin interface to integrate MAX messenger.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type {
  ChannelPlugin,
  ChannelMeta,
} from "openclaw/plugin-sdk/channel-runtime";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  buildChannelConfigSchema,
  formatPairingApproveHint,
  setAccountEnabledInConfigSection,
  deleteAccountFromConfigSection,
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "openclaw/plugin-sdk/core";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import { resolveToolsBySender } from "openclaw/plugin-sdk/channel-policy";

import type { GroupToolPolicyConfig } from "openclaw/plugin-sdk/channel-policy";

import {
  listMaxAccountIds,
  resolveDefaultMaxAccountId,
  resolveMaxAccount,
  type ResolvedMaxAccount,
} from "./accounts.js";
import { MaxApi, type MaxUser } from "./api.js";
import { readMaxChannelButtons, sendMaxMessage, sendMaxMediaMessage } from "./send.js";
import { startMaxPolling } from "./monitor.js";
import { getMaxRuntime } from "./runtime.js";
import { maxSetupWizard } from "./onboarding.js";
import { MaxConfigSchema } from "./config-schema.js";
import { maxMessageActions } from "./actions.js";
import {
  buildMaxModelBrowseChannelData,
  buildMaxModelsAddProviderChannelData,
  buildMaxModelsListChannelData,
  buildMaxModelsMenuChannelData,
  buildMaxModelsProviderChannelData,
} from "./model-buttons.js";

// ── MAX group policy helpers ──
// These mirror resolveChannelGroupRequireMention/resolveChannelGroupToolsPolicy
// (internal SDK functions not exported) but for the "max" channel.

function resolveMaxGroupConfig(cfg: OpenClawConfig, groupId?: string | null, accountId?: string | null) {
  const maxSection = (cfg.channels as Record<string, unknown>)?.max as Record<string, unknown> | undefined;
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
  const groupConfig = normalizedId && groups
    ? (groups[normalizedId] as Record<string, unknown> | undefined)
    : undefined;
  const defaultConfig = groups?.["*"] as Record<string, unknown> | undefined;

  return { groupConfig, defaultConfig };
}

function resolveMaxGroupRequireMention(params: {
  cfg: OpenClawConfig;
  groupId?: string | null;
  accountId?: string | null;
}): boolean {
  const { groupConfig, defaultConfig } = resolveMaxGroupConfig(params.cfg, params.groupId, params.accountId);
  const configMention =
    typeof groupConfig?.requireMention === "boolean"
      ? groupConfig.requireMention
      : typeof defaultConfig?.requireMention === "boolean"
        ? defaultConfig.requireMention
        : undefined;
  if (typeof configMention === "boolean") return configMention;
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
  const { groupConfig, defaultConfig } = resolveMaxGroupConfig(params.cfg, params.groupId, params.accountId);

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
    toolsBySender: defaultConfig?.toolsBySender as Record<string, GroupToolPolicyConfig> | undefined,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  if (defaultSenderPolicy) return defaultSenderPolicy;
  if (defaultConfig?.tools) return defaultConfig.tools as GroupToolPolicyConfig;

  return undefined;
}

// ── Meta ──

const maxMeta: ChannelMeta = {
  id: "max",
  label: "MAX",
  selectionLabel: "MAX Messenger",
  docsPath: "/channels/max",
  blurb: "MAX messenger bot via platform-api.max.ru. Supports DMs, groups, inline keyboards.",
  order: 50,
  aliases: ["max-messenger"],
};

// ── Channel Plugin ──

export const maxPlugin: ChannelPlugin<ResolvedMaxAccount> = {
  id: "max",
  meta: maxMeta,
  setupWizard: maxSetupWizard,
  configSchema: buildChannelConfigSchema(MaxConfigSchema),

  capabilities: {
    chatTypes: ["direct", "group", "channel"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: true,
    blockStreaming: false,
    edit: true,
    polls: false,
  },

  reload: { configPrefixes: ["channels.max"] },

  commands: {
    nativeCommandsAutoEnabled: true,
    nativeSkillsAutoEnabled: true,
    buildModelsMenuChannelData: buildMaxModelsMenuChannelData,
    buildModelsProviderChannelData: buildMaxModelsProviderChannelData,
    buildModelsAddProviderChannelData: buildMaxModelsAddProviderChannelData,
    buildModelsListChannelData: buildMaxModelsListChannelData,
    buildModelBrowseChannelData: buildMaxModelBrowseChannelData,
  },

  agentPrompt: {
    messageToolHints: () => {
      // Compact sticker emoji map: top 50 emojis → sticker codes
      // Codes are hex IDs derived from listmax.ru external_id: parseInt(extId).toString(16)
      const emojiMap = "😂:109550b5 😊:109971b5 😍:10931eb5 🥰:10931eb5 😢:109330b5 😭:109330b5 😡:10941fb5 😱:109302b5 🤔:109308b5 👍:109368b5 👎:109323b5 ❤️:10931eb5 🔥:b4867ebb 💪:c1254bbb 🎉:10933cb5 😘:10931eb5 🤗:109b94b5 😎:10931db5 🙄:c14211bb 😴:10936eb5 😤:10941fb5 🤮:6b8bb 🤯:109302b5 😳:109302b5 🥳:10933cb5 💀:b4863ebb 🙈:b4850cbb 😏:11e4c60bb 😅:109550b5 🤣:109550b5 😋:109d2db5 😜:455b5 🤷:10d5cf5bb 😫:10936eb5 😩:10997db5 🥺:109356b5 😌:14aae3bb 😒:109323b5 🤪:455b5 😇:11e4dedbb 🙏:50cb5 💔:10997db5 👀:b48534bb ✨:11e43b2bb 😈:10941fb5 🤝:109368b5 🤦:502b5 😬:5dab4b5 🤩:5dabfb5 😶:2ae2b5";

      // Also try to load full sticker-emoji-map.json for extended catalog
      let extendedHint = "";
      try {
        const fs = require("fs");
        const path = require("path");
        const candidates = [
          path.join(__dirname, "..", "sticker-emoji-map.json"),
          path.join(process.cwd(), "projects", "openclaw-max", "sticker-emoji-map.json"),
        ];
        for (const p of candidates) {
          if (fs.existsSync(p)) {
            extendedHint = " Full emoji→sticker map available at: " + p;
            break;
          }
        }
      } catch {}

      return [
        '- MAX stickers: use `message(action="sticker", target="CHAT_ID", stickerId="CODE")`. Pick a sticker code matching the mood from the emoji map below. Each entry is emoji:hexCode.',
        `- Sticker emoji map: ${emojiMap}${extendedHint}`,
        '- MAX location: use `message(action="sendAttachment", target="CHAT_ID", type="location", latitude="55.75", longitude="37.62")` to send a native map pin.',
        '- MAX contact: use `message(action="sendAttachment", target="CHAT_ID", type="contact", contactName="Name", vcfPhone="+70001234567")` to send a native contact card.',
      ];
    },
  },

  config: {
    listAccountIds: (cfg) => listMaxAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveMaxAccount({ cfg, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,

    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "max",
        accountId,
        enabled,
        allowTopLevel: true,
      }),

    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "max",
        accountId,
        clearBaseFields: ["botToken", "tokenFile", "name"],
      }),

    isConfigured: (account) => Boolean(account.token?.trim()),

    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
    }),

    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveMaxAccount({ cfg, accountId }).config.allowFrom ?? []).map(String),

    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^max:/i, "")),
  },

  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const maxSection = (cfg.channels as Record<string, unknown>)?.max as Record<string, unknown> | undefined;
      const useAccountPath = Boolean(
        (maxSection?.accounts as Record<string, unknown>)?.[resolvedAccountId],
      );
      const basePath = useAccountPath
        ? `channels.max.accounts.${resolvedAccountId}.`
        : "channels.max.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("max"),
        normalizeEntry: (raw: string) => raw.replace(/^max:/i, ""),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") {
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
  },

  groups: {
    resolveRequireMention: ({ cfg, groupId, accountId }) =>
      resolveMaxGroupRequireMention({ cfg, groupId, accountId }),
    resolveToolPolicy: ({ cfg, groupId, accountId, senderId, senderName, senderUsername, senderE164 }) =>
      resolveMaxGroupToolPolicy({ cfg, groupId, accountId, senderId, senderName, senderUsername, senderE164 }),
  },

  pairing: {
    idLabel: "maxUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^max:/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveMaxAccount({ cfg });
      if (!account.token) throw new Error("MAX bot token not configured");
      await sendMaxMessage(id, PAIRING_APPROVED_MESSAGE, { token: account.token });
    },
  },

  threading: {
    resolveReplyToMode: () => "first",
  },

  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = raw.trim();
      const normalized = trimmed.startsWith("max:") ? trimmed.slice(4) : trimmed;
      // MAX uses numeric IDs
      if (/^-?\d+$/.test(normalized)) return normalized;
      return undefined;
    },
    targetResolver: {
      looksLikeId: (raw) => /^-?\d+$/.test(raw.trim().replace(/^max:/, "")),
      hint: "<chatId|userId>",
    },
  },

  directory: {
    self: async ({ cfg, accountId }) => {
      const account = resolveMaxAccount({ cfg, accountId });
      if (!account.token) return null;
      try {
        const api = new MaxApi({ token: account.token, timeoutMs: 3000 });
        const me = await api.getMe();
        return {
          kind: "user" as const,
          id: String(me.user_id),
          name: me.first_name || undefined,
          handle: me.username || undefined,
        };
      } catch {
        return null;
      }
    },
    listPeers: async ({ cfg, accountId }) => {
      const account = resolveMaxAccount({ cfg, accountId });
      // MAX doesn't expose a full user list API. Return peers from allowFrom config.
      const allowFrom = account.config.allowFrom ?? [];
      return allowFrom.map((id: string | number) => ({
        kind: "user" as const,
        id: String(id),
        name: undefined,
      }));
    },
    listGroups: async ({ cfg, accountId }) => {
      const account = resolveMaxAccount({ cfg, accountId });
      if (!account.token) return [];
      try {
        const api = new MaxApi({ token: account.token, timeoutMs: 5000 });
        const result = await api.getChats({ count: 100 });
        return (result.chats ?? [])
          .filter((chat) => chat.type === "chat" || chat.type === "channel")
          .map((chat) => {
            const kind: "channel" | "group" = chat.type === "channel" ? "channel" : "group";
            return {
              kind,
              id: String(chat.chat_id),
              name: chat.title || undefined,
            };
          });
      } catch {
        return [];
      }
    },
  },

  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getMaxRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,

    sendPayload: async ({ to, text, payload, mediaUrl, accountId, replyToId }) => {
      const cfg = await getMaxRuntime().config.loadConfig();
      const account = resolveMaxAccount({ cfg, accountId });
      if (!account.token) throw new Error("MAX bot token not configured");

      const buttons = readMaxChannelButtons(payload.channelData);
      const effectiveMediaUrl = mediaUrl ?? payload.mediaUrl ?? payload.mediaUrls?.[0];

      if (effectiveMediaUrl) {
        const result = await sendMaxMediaMessage(to, text, effectiveMediaUrl, {
          token: account.token,
          replyToMessageId: replyToId ?? undefined,
          format: "markdown",
          buttons,
        });
        return {
          channel: "max",
          messageId: result.messageId,
        };
      }

      const result = await sendMaxMessage(to, text, {
        token: account.token,
        replyToMessageId: replyToId ?? undefined,
        format: "markdown",
        buttons,
      });

      return {
        channel: "max",
        messageId: result.messageId,
      };
    },

    sendText: async ({ to, text, accountId, replyToId }) => {
      const cfg = await getMaxRuntime().config.loadConfig();
      const account = resolveMaxAccount({ cfg, accountId });
      if (!account.token) throw new Error("MAX bot token not configured");

      const result = await sendMaxMessage(to, text, {
        token: account.token,
        replyToMessageId: replyToId ?? undefined,
        format: "markdown",
      });

      return {
        channel: "max",
        messageId: result.messageId,
      };
    },

    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId }) => {
      const cfg = await getMaxRuntime().config.loadConfig();
      const account = resolveMaxAccount({ cfg, accountId });
      if (!account.token) throw new Error("MAX bot token not configured");

      if (!mediaUrl) {
        // No media, send as text
        const result = await sendMaxMessage(to, text, {
          token: account.token,
          replyToMessageId: replyToId ?? undefined,
          format: "markdown",
        });
        return {
          channel: "max",
          messageId: result.messageId,
        };
      }

      // Upload and send media
      const result = await sendMaxMediaMessage(to, text, mediaUrl, {
        token: account.token,
        replyToMessageId: replyToId ?? undefined,
        format: "markdown",
      });

      return {
        channel: "max",
        messageId: result.messageId,
      };
    },
  },

  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),

    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "max",
        accountId,
        name,
      }),

    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "MAX_BOT_TOKEN can only be used for the default account.";
      }
      if (!input.useEnv && !input.token && !input.tokenFile) {
        return "MAX requires --token or --token-file (or --use-env with MAX_BOT_TOKEN).";
      }
      return null;
    },

    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "max",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "max",
            })
          : namedConfig;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            max: {
              ...(next.channels as Record<string, unknown>)?.max as Record<string, unknown>,
              enabled: true,
              ...(input.useEnv
                ? {}
                : input.token
                  ? { botToken: input.token }
                  : {}),
            },
          },
        };
      }

      const maxSection = (next.channels as Record<string, unknown>)?.max as Record<string, unknown> ?? {};
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
                ...((maxSection.accounts as Record<string, unknown>)?.[accountId] as Record<string, unknown>),
                enabled: true,
                ...(input.token ? { botToken: input.token } : {}),
              },
            },
          },
        },
      };
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },

    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
    }),

    probeAccount: async ({ account, timeoutMs }) => {
      if (!account.token) return { ok: false, error: "no token" };
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
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
      running: runtime?.running ?? false,
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
      const groupIds = Object.keys(groups).filter((id) => id !== "*");

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
          const isMember = chat.type === "chat" || chat.type === "channel";
          if (!isMember) {
            unresolvedCount++;
            results.push({
              id: groupId,
              ok: false,
              error: "Bot is not a member of this chat",
            });
          } else {
            results.push({
              id: groupId,
              ok: true,
              title: chat.title ?? undefined,
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
        kind: "config" | "permissions" | "auth" | "runtime" | "intent";
        message: string;
        fix?: string;
      }> = [];

      for (const snapshot of accounts) {
        if (!snapshot.configured) {
          issues.push({
            channel: "max",
            accountId: snapshot.accountId,
            kind: "config" as const,
            message: "MAX bot token not configured",
            fix: "Set channels.max.botToken or MAX_BOT_TOKEN env var",
          });
        }
      }

      return issues;
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const token = account.token.trim();

      let botLabel = "";
      let botUserId: number | undefined;
      let botUsername: string | undefined;
      try {
        const probeApi = new MaxApi({ token, timeoutMs: 3000 });
        const me = await probeApi.getMe();
        if (me.username) {
          botLabel = ` (@${me.username})`;
          botUsername = me.username;
        }
        botUserId = me.user_id;
      } catch {
        // probe failed, continue anyway
      }

      ctx.log?.info(`[${account.accountId}] Starting MAX provider${botLabel}`);

      const api = new MaxApi({ token });

      // Register bot commands if configured
      const commands = ctx.cfg.channels?.max?.commands as Array<{ name: string; description?: string }> | undefined;
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
          await getMaxRuntime().config.writeConfigFile(nextCfg);
        }
      }

      return { cleared, loggedOut: cleared };
    },
  },

  // Message actions (send, edit, delete)
  actions: maxMessageActions,
};
