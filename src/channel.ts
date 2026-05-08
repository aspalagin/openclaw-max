/**
 * MAX channel plugin — OpenClaw channel adapter
 * Uses types.ts + polling.ts from Банзай, api.ts + sender.ts from openclaw-max
 */
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { emptyPluginConfigSchema, formatPairingApproveHint } from "openclaw/plugin-sdk/channel-plugin-common";
import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import { createDefaultChannelRuntimeState } from "openclaw/plugin-sdk/channel-status";
import { dispatchInboundDirectDmWithRuntime, resolveInboundDirectDmAccessWithRuntime } from "openclaw/plugin-sdk/direct-dm";
import { resolveCommandAuthorizedFromAuthorizers, shouldComputeCommandAuthorized } from "openclaw/plugin-sdk/command-auth";

const directDmCommandAuthRuntime = {
  shouldComputeCommandAuthorized,
  resolveCommandAuthorizedFromAuthorizers,
};

import * as os from "node:os";
import * as path from "node:path";
import type { SendMessageBody } from "./api.js";
import { sendMessage, sendTypingAction, getBotInfo, pinMessage, unpinMessage, subscribe, unsubscribe, getOrCreateDialog } from "./api.js";
import { answerCallback } from "./buttons.js";
import { listMaxAccountIds, resolveDefaultMaxAccountId, resolveMaxAccount } from "./config.js";
import { downloadAttachment } from "./media.js";
import { startPolling } from "./polling.js";
import { startWebhook } from "./webhook.js";
import { editText, removeMessage, sendLocalFile, sendText, splitText } from "./sender.js";
import type {
  Attachment,
  AudioAttachment,
  ContactAttachment,
  FileAttachment,
  LocationAttachment,
  MaxChannelConfig,
  Message,
  MessageCallbackUpdate,
  MessageCreatedUpdate,
  PhotoAttachment,
  ResolvedMaxAccount,
  ShareAttachment,
  StickerAttachment,
  Update,
  User,
  VideoAttachment,
} from "./types.js";

// ─── Runtime reference (set by index.ts) ─────────────────────────

let _runtime: unknown = null;

export function setMaxRuntime(rt: unknown): void {
  _runtime = rt;
}

export function getMaxRuntime(): unknown {
  return _runtime;
}

// ─── Active polling handles ───────────────────────────────────────

const activeStopFns = new Map<string, () => void>();
const botInfoCache = new Map<string, User>();
const MAX_TRACKED_ENTRIES = 10_000;

export function getBotUser(accountId: string): User | undefined {
  return botInfoCache.get(accountId);
}

// ─── userId → chatId mapping (populated from inbound messages) ───

const userIdToChatId = new Map<string, number>();

export function resolveMaxChatId(userId: string): number | undefined {
  return userIdToChatId.get(userId);
}

// ─── Streaming: track preview message IDs ─────────────────────────

const streamingMessages = new Map<string, string>();

function setBoundedMapEntry<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);

  while (map.size > MAX_TRACKED_ENTRIES) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

async function cleanupLocalFiles(
  filePaths: string[],
  log?: { debug?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<void> {
  if (filePaths.length === 0) return;
  const fs = await import("node:fs/promises");
  await Promise.all(filePaths.map(async (filePath) => {
    try {
      await fs.unlink(filePath);
      log?.debug?.(`[max] cleaned up temp file ${filePath}`);
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error?.code !== "ENOENT") {
        log?.warn?.(`[max] failed to clean up temp file ${filePath}: ${error.message}`);
      }
    }
  }));
}

// ─── Attachment helpers ───────────────────────────────────────────

function isMediaAttachment(
  a: Attachment,
): a is PhotoAttachment | VideoAttachment | AudioAttachment | FileAttachment {
  return a.type === "image" || a.type === "video" || a.type === "audio" || a.type === "file";
}

interface AttachmentRef {
  url: string;
  filename?: string;
}

function extractAttachmentRefs(attachments: Attachment[]): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  for (const att of attachments) {
    if (!isMediaAttachment(att)) continue;
    const url = att.payload.url;
    if (!url) continue;
    const ref: AttachmentRef = { url };
    if ("filename" in att.payload && att.payload.filename) {
      ref.filename = att.payload.filename;
    }
    refs.push(ref);
  }
  return refs;
}

/**
 * Download all media attachments to a temp dir and return local paths.
 * Errors per-file are logged but non-fatal.
 */
async function downloadAttachments(
  refs: AttachmentRef[],
  token: string,
  accountId: string,
  log?: { debug?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<string[]> {
  if (refs.length === 0) return [];
  const destDir = path.join(os.homedir(), ".openclaw", "media", "inbound", "max", accountId);
  const localPaths: string[] = [];
  for (const ref of refs) {
    try {
      const filePath = await downloadAttachment(ref.url, token, destDir);
      localPaths.push(filePath);
      log?.debug?.(`[max:${accountId}] Downloaded attachment → ${filePath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.warn?.(`[max:${accountId}] Failed to download attachment: ${msg}`);
    }
  }
  return localPaths;
}

// ─── Extract chatId from inbound message ─────────────────────────

function resolveChatId(msg: Message): number {
  if (msg.recipient.chat_id !== undefined) return msg.recipient.chat_id;
  if (msg.sender?.user_id !== undefined) return msg.sender.user_id;
  return 0;
}

// ─── Channel plugin ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const maxPlugin: any = {
  id: "max",
  meta: {
    id: "max",
    label: "MAX",
    selectionLabel: "MAX (max.ru)",
    docsPath: "/channels/max",
    docsLabel: "max",
    blurb: "MAX messenger channel (max.ru Bot API).",
    order: 90,
    aliases: ["maxru", "max.ru"],
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
  },
  reload: { configPrefixes: ["channels.max"] },
  configSchema: emptyPluginConfigSchema(),

  config: {
    listAccountIds: (cfg: Record<string, unknown>) => listMaxAccountIds(cfg),
    resolveAccount: (cfg: Record<string, unknown>, accountId?: string | null) =>
      resolveMaxAccount({ cfg, accountId }),
    defaultAccountId: (cfg: Record<string, unknown>) => resolveDefaultMaxAccountId(cfg),
    isConfigured: (account: ResolvedMaxAccount) => account.configured,
    describeAccount: (account: ResolvedMaxAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      botUsername: botInfoCache.get(account.accountId)?.username ?? null,
      botUserId: botInfoCache.get(account.accountId)?.user_id ?? null,
    }),
    resolveAllowFrom: ({
      cfg,
      accountId,
    }: {
      cfg: Record<string, unknown>;
      accountId?: string | null;
    }) =>
      mapAllowFromEntries(resolveMaxAccount({ cfg, accountId }).config.allowFrom ?? []),
    formatAllowFrom: ({ allowFrom }: { allowFrom: string[] }) =>
      allowFrom.map((e) => String(e).trim()).filter(Boolean),
  },

  pairing: {
    idLabel: "maxUserId",
    normalizeAllowEntry: (entry: string) => entry.replace(/^max:/i, "").trim(),
    notifyApproval: async ({ id, accountId }: { id: string; accountId?: string }) => {
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const rt = _runtime as {
        config?: { loadConfig?: () => Record<string, unknown> };
      } | null;
      if (!rt?.config?.loadConfig) return;
      const cfg = rt.config.loadConfig();
      const account = resolveMaxAccount({ cfg, accountId: aid });
      if (!account.configured) return;
      try {
        await sendText(
          account.botToken,
          Number(id),
          "✅ Ваш запрос на сопряжение одобрен! Теперь можно общаться.",
        );
      } catch {
        // Non-critical
      }
    },
  },

  security: {
    resolveDmPolicy: ({ account }: { account: ResolvedMaxAccount }) => ({
      policy: account.config.dmPolicy ?? "pairing",
      allowFrom: account.config.allowFrom ?? [],
      policyPath: "channels.max.dmPolicy",
      allowFromPath: "channels.max.allowFrom",
      approveHint: formatPairingApproveHint("max"),
      normalizeEntry: (raw: string) => raw.replace(/^max:/i, "").trim(),
    }),
  },

  messaging: {
    normalizeTarget: (target: string) => target.replace(/^max:/i, "").trim(),
    targetResolver: {
      looksLikeId: (input: string) => /^\d+$/.test(input.trim()),
      hint: "<userId или chat_id>",
    },
  },

  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 4000,

    sendText: async ({
      cfg,
      to,
      text,
      accountId,
      replyTo,
    }: {
      cfg: Record<string, unknown>;
      to: string;
      text?: string | null;
      accountId?: string | null;
      replyTo?: string | null;
    }) => {
      const account = resolveMaxAccount({ cfg, accountId });
      if (!account.configured) {
        throw new Error(`MAX account ${account.accountId} not configured`);
      }

      const fallbackTo = String((cfg.channels as any)?.max?.allowFrom?.[0] ?? "").trim();
      const target = to === "default" && fallbackTo ? fallbackTo : to;

      // Если нет кэшированного chatId — пробуем получить через getOrCreateDialog
      if (!userIdToChatId.has(target)) {
        try {
          const resolvedChatId = await getOrCreateDialog(account.botToken, Number(target));
          setBoundedMapEntry(userIdToChatId, target, resolvedChatId);
        } catch {
          // Фоллбэк: отправим как user_id
        }
      }

      const targetMode = userIdToChatId.has(target) ? "chat" : "user";
      const chatId = userIdToChatId.get(target) ?? Number(target);
      if (isNaN(chatId)) throw new Error(`Invalid MAX chat_id: ${to}`);

      // Чанкование текста если > 4000 символов
      const fullText = text ?? "";
      const chunks = splitText(fullText, 4000);
      let msgId = "";
      for (let i = 0; i < chunks.length; i++) {
        msgId = await sendText(account.botToken, chatId, chunks[i], {
          replyTo: i === 0 ? (replyTo ?? undefined) : undefined,
          targetMode,
        });
      }
      return { channel: "max" as const, to: target, messageId: msgId };
    },

    pinMessage: async ({
      cfg,
      chatId,
      messageId,
      accountId,
    }: {
      cfg: Record<string, unknown>;
      chatId: string;
      messageId: string;
      accountId?: string | null;
    }) => {
      const account = resolveMaxAccount({ cfg, accountId });
      if (!account.configured) throw new Error("not configured");
      await pinMessage(account.botToken, Number(chatId), messageId);
    },

    unpinMessage: async ({
      cfg,
      chatId,
      accountId,
    }: {
      cfg: Record<string, unknown>;
      chatId: string;
      accountId?: string | null;
    }) => {
      const account = resolveMaxAccount({ cfg, accountId });
      if (!account.configured) throw new Error("not configured");
      await unpinMessage(account.botToken, Number(chatId));
    },

    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      accountId,
      replyTo,
    }: {
      cfg: Record<string, unknown>;
      to: string;
      text?: string | null;
      mediaUrl?: string | null;
      accountId?: string | null;
      replyTo?: string | null;
    }) => {
      const account = resolveMaxAccount({ cfg, accountId });
      if (!account.configured) {
        throw new Error(`MAX account ${account.accountId} not configured`);
      }

      const fallbackTo = String((cfg.channels as any)?.max?.allowFrom?.[0] ?? "").trim();
      const target = to === "default" && fallbackTo ? fallbackTo : to;

      // Если нет кэшированного chatId — пробуем получить через getOrCreateDialog
      if (!userIdToChatId.has(target)) {
        try {
          const resolvedChatId = await getOrCreateDialog(account.botToken, Number(target));
          setBoundedMapEntry(userIdToChatId, target, resolvedChatId);
        } catch {
          // Фоллбэк: отправим как user_id
        }
      }

      const targetMode = userIdToChatId.has(target) ? "chat" : "user";
      const chatId = userIdToChatId.get(target) ?? Number(target);
      if (isNaN(chatId)) throw new Error(`Invalid MAX chat_id: ${to}`);


      if (!mediaUrl) throw new Error("sendMedia called without mediaUrl");

      // Local file path
      if (!mediaUrl.startsWith("http")) {
        const msgId = await sendLocalFile(account.botToken, chatId, mediaUrl, text ?? undefined, replyTo ?? undefined, targetMode);
        return { channel: "max" as const, to: target, messageId: msgId };
      }

      // Remote URL — download then send
      const { downloadFile } = await import("./api.js");
      const tmpDir = "/tmp/openclaw-max-media";
      const fs = await import("node:fs");
      const path = await import("node:path");
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      const filename = path.basename(new URL(mediaUrl).pathname) || `media_${Date.now()}`;
      const tmpPath = path.join(tmpDir, filename);
      try {
        const buf = await downloadFile(mediaUrl, account.botToken);
        fs.writeFileSync(tmpPath, buf);
        const msgId = await sendLocalFile(account.botToken, chatId, tmpPath, text ?? undefined, replyTo ?? undefined, targetMode);
        return { channel: "max" as const, to: target, messageId: msgId };
      } finally {
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
          // best-effort cleanup
        }
      }
    },
  },

  // ─── Streaming support ─────────────────────────────────────────

  streaming: {
    supported: true,

    sendPartial: async ({
      cfg,
      to,
      text,
      accountId,
      sessionKey,
      replyTo,
    }: {
      cfg: Record<string, unknown>;
      to: string;
      text: string;
      accountId?: string | null;
      sessionKey?: string | null;
      replyTo?: string | null;
    }) => {
      const account = resolveMaxAccount({ cfg, accountId });
      if (!account.configured) return;
      const chatId = userIdToChatId.get(to) ?? Number(to);
      if (isNaN(chatId)) return;

      const key = sessionKey ?? `${account.accountId}:${to}`;
      const existingId = streamingMessages.get(key);

      try {
        // Send typing indicator alongside streaming updates
        sendTypingAction(account.botToken, chatId).catch(() => {});

        if (existingId) {
          await editText(account.botToken, existingId, text + " ▍");
        } else {
          const msgId = await sendText(account.botToken, chatId, text + " ▍", {
            replyTo: replyTo ?? undefined,
          });
          setBoundedMapEntry(streamingMessages, key, msgId);
        }
      } catch {
        // Streaming errors are non-fatal
      }
    },

    finalize: async ({
      cfg,
      to,
      text,
      accountId,
      sessionKey,
    }: {
      cfg: Record<string, unknown>;
      to: string;
      text: string;
      accountId?: string | null;
      sessionKey?: string | null;
    }) => {
      const account = resolveMaxAccount({ cfg, accountId });
      if (!account.configured) return;
      const chatId = userIdToChatId.get(to) ?? Number(to);
      if (isNaN(chatId)) return;

      const key = sessionKey ?? `${account.accountId}:${to}`;
      const existingId = streamingMessages.get(key);
      streamingMessages.delete(key);

      try {
        if (existingId) {
          // Если текст > 4000, редактируем первое сообщение с первым чанком, остальные отправляем отдельно
          const chunks = splitText(text, 4000);
          await editText(account.botToken, existingId, chunks[0]);
          for (let i = 1; i < chunks.length; i++) {
            await sendText(account.botToken, chatId, chunks[i]);
          }
        } else {
          const chunks = splitText(text, 4000);
          for (const chunk of chunks) {
            await sendText(account.botToken, chatId, chunk);
          }
        }
      } catch (err) {
        // Cleanup key on error too
        streamingMessages.delete(key);
        throw err;
      }
    },
  },

  // ─── Status ────────────────────────────────────────────────────

  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    buildAccountSnapshot: ({
      account,
      runtime,
    }: {
      account: ResolvedMaxAccount;
      runtime?: {
        running?: boolean;
        lastStartAt?: string | null;
        lastStopAt?: string | null;
        lastError?: string | null;
      };
    }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },

  // ─── Gateway: start/stop long polling ─────────────────────────

  gateway: {
    startAccount: async (ctx: {
      account: ResolvedMaxAccount;
      abortSignal?: AbortSignal;
      runtime?: unknown;
      channelRuntime?: unknown;
      log?: {
        info: (msg: string) => void;
        debug?: (msg: string) => void;
        warn?: (msg: string) => void;
        error?: (msg: string) => void;
      };
      setStatus: (status: Record<string, unknown>) => void;
    }) => {
      const { account } = ctx;

      if (!account.configured) {
        throw new Error("MAX bot token not configured");
      }

      // Получаем информацию о боте (username, user_id) для проверки mention
      try {
        const botUser = await getBotInfo(account.botToken);
        botInfoCache.set(account.accountId, botUser);
        ctx.log?.info(`[max:${account.accountId}] Bot info: @${botUser.username} (id=${botUser.user_id})`);
      } catch (err) {
        ctx.log?.warn?.(`[max:${account.accountId}] Не удалось получить bot info: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Resolve transport mode from channel config
      const runtimeCfg = ((_runtime as any)?.config?.loadConfig?.() ?? {}) as Record<string, unknown>;
      const channelsCfg = runtimeCfg.channels as Record<string, unknown> | undefined;
      const maxChannelCfg = channelsCfg?.max as MaxChannelConfig | undefined;
      const transport = maxChannelCfg?.transport ?? "polling";

      ctx.log?.info(`[max:${account.accountId}] Starting MAX channel (${transport})...`);

      // ─── Shared: message handler ────────────────────────────────

      const handleMessage = async (update: MessageCreatedUpdate) => {
        const msg = update.message;
        const senderId = String(msg.sender?.user_id ?? 0);
        const chatId = resolveChatId(msg);
        // Extract text and attachments from body or forwarded message
        let text = msg.body.text ?? "";
        let attachments = msg.body.attachments ?? [];

        // Handle forwarded messages: attachments/text are in link.message
        if (msg.link?.type === "forward" && msg.link.message) {
          const fwd = msg.link.message;
          if (!text && fwd.text) {
            text = fwd.text;
          }
          if ((!attachments || attachments.length === 0) && fwd.attachments) {
            attachments = fwd.attachments;
          }
        }
        const isGroup = msg.recipient.chat_type === "chat";
        const senderName = msg.sender
          ? [msg.sender.first_name, msg.sender.last_name].filter(Boolean).join(" ")
          : undefined;
        const senderUsername = msg.sender?.username ?? undefined;

        ctx.log?.info?.(
          `[max:${account.accountId}] from=${senderId} chat=${chatId} group=${isGroup} text="${text.slice(0, 60)}"`,
        );

        // ─── Group policy check ─────────────────────────────────
        if (isGroup) {
          const groupPolicy = account.config.groupPolicy ?? "open";
          if (groupPolicy === "disabled") {
            ctx.log?.debug?.(`[max:${account.accountId}] Group messages disabled, ignoring chat=${chatId}`);
            return;
          }
          if (groupPolicy === "allowlist") {
            const allowed = account.config.allowGroups ?? [];
            const chatIdStr = String(chatId);
            if (!allowed.some((g) => String(g) === chatIdStr)) {
              ctx.log?.debug?.(`[max:${account.accountId}] Group ${chatId} not in allowlist, ignoring`);
              return;
            }
          }

          // ─── Bot mention check in groups ──────────────────────
          const requireMention = account.config.requireMention !== false;
          if (requireMention) {
            const botUser = botInfoCache.get(account.accountId);
            const botUsername = botUser?.username;
            const botUserId = botUser?.user_id;
            const hasBotMention = botUsername
              ? text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)
              : /@\w+bot\b/i.test(text);
            const isReplyToBot = msg.link?.type === "reply" && (
              botUserId
                ? msg.link?.sender?.user_id === botUserId
                : msg.link?.sender?.is_bot === true
            );
            if (!isReplyToBot && !hasBotMention) {
              ctx.log?.debug?.(`[max:${account.accountId}] No bot mention in group, ignoring`);
              return;
            }
            // Вырезаем @username бота из текста перед отправкой в агент
            if (botUsername && hasBotMention) {
              text = text.replace(new RegExp(`@${botUsername}\\b`, "gi"), "").trim();
            }
          }
        }

        // ─── DM access check (allowlist / pairing) ────────
        if (!isGroup) {
          const cfg = ((_runtime as any)?.config?.loadConfig?.() ?? {}) as Record<string, unknown>;
          const dmAccess = await resolveInboundDirectDmAccessWithRuntime({
            cfg: cfg as any,
            channel: "max",
            accountId: account.accountId,
            dmPolicy: account.config.dmPolicy ?? "pairing",
            allowFrom: account.config.allowFrom ?? [],
            senderId,
            rawBody: text,
            isSenderAllowed: (sid: string, allowList: string[]) =>
              allowList.some((entry) => String(entry) === sid),
            runtime: directDmCommandAuthRuntime as any,
          });

          if (dmAccess.access.decision === "block") {
            ctx.log?.info?.(
              `[max:${account.accountId}] DM blocked from=${senderId} reason=${dmAccess.access.reasonCode}`,
            );
            return;
          }

          if (dmAccess.access.decision === "pairing") {
            ctx.log?.info?.(
              `[max:${account.accountId}] DM pairing challenge for from=${senderId}`,
            );
            try {
              await sendText(
                account.botToken,
                chatId,
                `🔒 Запрос на сопряжение отправлен. Ваш MAX ID: ${senderId}\nОжидайте подтверждения.`,
              );
            } catch {
              // Non-critical
            }
            return;
          }
        }

        // Cache userId → chatId mapping for outbound delivery
        if (senderId && chatId) {
          setBoundedMapEntry(userIdToChatId, senderId, chatId);
        }

        // Send typing indicator
        sendTypingAction(account.botToken, chatId).catch(() => {});

        // Download attachments to local media/inbound dir
        const attRefs = extractAttachmentRefs(attachments);
        const localFiles = await downloadAttachments(
          attRefs,
          account.botToken,
          account.accountId,
          ctx.log,
        );

        try {
          // If text is empty but we have media, provide a placeholder so the
          // message isn't discarded by the dispatch pipeline
          const isForward = msg.link?.type === "forward";
          let bodyForAgent = text;
          if (!bodyForAgent && localFiles.length > 0) {
            const mediaTypes = attachments
              .filter((a): a is PhotoAttachment | VideoAttachment | AudioAttachment | FileAttachment =>
                a.type === "image" || a.type === "video" || a.type === "audio" || a.type === "file")
              .map((a) => a.type);
            const label = isForward ? "Forwarded" : "Attached";
            bodyForAgent = `[${label} ${mediaTypes.join(", ") || "media"}]`;
          }

          // Enrich bodyForAgent with special attachment descriptions
          const specialParts: string[] = [];
          for (const att of attachments) {
            if (att.type === "sticker") {
              specialParts.push(`[Sticker: ${(att as StickerAttachment).payload.code}]`);
            } else if (att.type === "location") {
              const loc = (att as LocationAttachment).payload;
              specialParts.push(`[Location: ${loc.latitude}, ${loc.longitude}]`);
            } else if (att.type === "contact") {
              const contact = (att as ContactAttachment).payload;
              const name = contact.max_info
                ? [contact.max_info.first_name, contact.max_info.last_name].filter(Boolean).join(" ")
                : "unknown";
              specialParts.push(`[Contact: ${name}]`);
            } else if (att.type === "share") {
              const share = (att as ShareAttachment).payload;
              if (share.url) specialParts.push(`[Share: ${share.url}]`);
            }
          }
          if (specialParts.length > 0) {
            bodyForAgent = bodyForAgent
              ? `${bodyForAgent}\n${specialParts.join("\n")}`
              : specialParts.join("\n");
          }

          // Use SDK pipeline to route and dispatch inbound message
          const cfg = ((_runtime as any)?.config?.loadConfig?.() ?? {}) as Record<string, unknown>;

          // Determine peer kind and target ID for groups vs DMs
          const peerKind = isGroup ? ("group" as const) : ("direct" as const);
          const peerId = isGroup ? String(chatId) : senderId;
          const conversationLabel = isGroup ? `MAX Group ${chatId}` : `MAX DM ${senderId}`;

          try {
            ctx.log?.info?.(`[max:${account.accountId}] dispatching from=${senderId} chat=${chatId} peer=${peerKind}`);

            await dispatchInboundDirectDmWithRuntime({
              cfg: cfg as any,
              channel: "max",
              channelLabel: "max",
              accountId: account.accountId,
              peer: { kind: peerKind, id: peerId },
              senderAddress: senderId,
              recipientAddress: String(chatId),
              senderId,
              conversationLabel,
              rawBody: text || bodyForAgent,
              bodyForAgent,
              commandBody: text || bodyForAgent,
              messageId: msg.body.mid ?? String(Date.now()),
              timestamp: msg.timestamp ?? Date.now(),
              commandAuthorized: true,
              provider: "max",
              surface: "max",
              runtime: _runtime as any,
              extraContext: {
                MediaPath: localFiles.length > 0 ? localFiles[0] : undefined,
                MediaPaths: localFiles.length > 0 ? localFiles : undefined,
                senderName,
                senderUsername,
                isGroup,
                chatId,
              },
              deliver: async (payload: any) => {
                const responseText = payload?.text?.trim() ?? "";
                if (responseText) {
                  await sendText(account.botToken, chatId, responseText);
                }
              },
              onRecordError: (err: unknown) => {
                ctx.log?.warn?.(`[max:${account.accountId}] session record error: ${err}`);
              },
              onDispatchError: (err: unknown) => {
                ctx.log?.error?.(`[max:${account.accountId}] dispatch error: ${err}`);
              },
            } as any);
          } catch (err) {
            ctx.log?.error?.(`[max:${account.accountId}] inbound error: ${err instanceof Error ? err.message : String(err)}`);
          }
        } finally {
          await cleanupLocalFiles(localFiles, ctx.log);
        }
      };

      // ─── Shared: generic update handler (callbacks, etc.) ──────

      const handleUpdate = async (update: Update) => {
        // Handle edited messages — re-dispatch as a new inbound message
        if (update.update_type === "message_edited") {
          const edited = update as unknown as MessageCreatedUpdate; // same shape as message_created
          const msg = edited.message;
          const editedText = msg.body.text?.trim();
          if (!editedText) return;

          const editSenderId = String(msg.sender?.user_id ?? 0);
          const editChatId = resolveChatId(msg);
          ctx.log?.info?.(
            `[max:${account.accountId}] edited from=${editSenderId} chat=${editChatId} text="${editedText.slice(0, 60)}"`,
          );

          // Re-use handleMessage to process edited message like a new one
          await handleMessage({
            ...update,
            update_type: "message_created",
          } as unknown as MessageCreatedUpdate);
          return;
        }

        if (update.update_type === "message_callback") {
          const cbUpdate = update as MessageCallbackUpdate;
          const cb = cbUpdate.callback;
          const payload = cb.payload ?? "";
          const senderId = String(cb.user.user_id);
          const chatId = cb.message?.recipient?.chat_id ?? 0;

          ctx.log?.info?.(
            `[max:${account.accountId}] callback from=${senderId} chat=${chatId} payload="${payload.slice(0, 60)}"`,
          );

          // Answer callback immediately to remove loading state
          try {
            await answerCallback(account.botToken, cb.callback_id);
          } catch (err) {
            ctx.log?.warn?.(`[max:${account.accountId}] answerCallback error: ${err}`);
          }

          if (!payload) return;

          // Cache mapping
          if (senderId && chatId) {
            setBoundedMapEntry(userIdToChatId, senderId, chatId);
          }

          // Dispatch callback payload as if it were a text message
          const cfg = ((_runtime as any)?.config?.loadConfig?.() ?? {}) as Record<string, unknown>;

          try {
            await dispatchInboundDirectDmWithRuntime({
              cfg: cfg as any,
              channel: "max",
              channelLabel: "max",
              accountId: account.accountId,
              peer: { kind: "direct" as const, id: senderId },
              senderAddress: senderId,
              recipientAddress: String(chatId),
              senderId,
              conversationLabel: `MAX DM ${senderId}`,
              rawBody: payload,
              bodyForAgent: payload,
              commandBody: payload,
              messageId: cb.callback_id,
              timestamp: cb.timestamp ?? Date.now(),
              commandAuthorized: true,
              provider: "max",
              surface: "max",
              runtime: _runtime as any,
              extraContext: {
                isCallback: true,
                callbackId: cb.callback_id,
                senderName: [cb.user.first_name, cb.user.last_name].filter(Boolean).join(" ") || undefined,
                senderUsername: cb.user.username ?? undefined,
              },
              deliver: async (deliverPayload: any) => {
                const responseText = deliverPayload?.text?.trim() ?? "";
                if (responseText && chatId) {
                  await sendText(account.botToken, chatId, responseText);
                }
              },
              onRecordError: (err: unknown) => {
                ctx.log?.warn?.(`[max:${account.accountId}] callback session record error: ${err}`);
              },
              onDispatchError: (err: unknown) => {
                ctx.log?.error?.(`[max:${account.accountId}] callback dispatch error: ${err}`);
              },
            } as any);
          } catch (err) {
            ctx.log?.error?.(`[max:${account.accountId}] callback inbound error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      };

      // ─── Start transport ───────────────────────────────────────

      const updateTypes = ["message_created", "message_edited", "bot_started", "message_callback"];

      // Регистрируем webhook-подписку на стороне MAX перед запуском сервера
      if (transport === "webhook" && maxChannelCfg?.webhookUrl) {
        try {
          await subscribe(account.botToken, maxChannelCfg.webhookUrl, updateTypes as import("./types.js").UpdateType[]);
          ctx.log?.info(`[max:${account.accountId}] Subscribed to webhook: ${maxChannelCfg.webhookUrl}`);
        } catch (err) {
          ctx.log?.warn?.(`[max:${account.accountId}] Не удалось зарегистрировать webhook: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Return a Promise that stays alive until abortSignal fires
      return new Promise<void>((resolve) => {
        let stopFn: () => void;

        if (transport === "webhook" && maxChannelCfg?.webhookUrl) {
          // Webhook mode
          stopFn = startWebhook(
            account.botToken,
            handleMessage,
            {
              webhookUrl: maxChannelCfg.webhookUrl,
              port: maxChannelCfg.webhookPort,
              types: updateTypes,
            },
            handleUpdate,
          );
        } else {
          // Polling mode (default)
          stopFn = startPolling(
            account.botToken,
            handleMessage,
            { types: updateTypes, onUpdate: handleUpdate },
          );
        }

        activeStopFns.set(account.accountId, stopFn);
        ctx.log?.info(`[max:${account.accountId}] MAX channel started (${transport}).`);

        // When gateway signals abort — stop and resolve (clean shutdown)
        if (ctx.abortSignal) {
          ctx.abortSignal.addEventListener("abort", () => {
            stopFn();
            activeStopFns.delete(account.accountId);
            // Отписываемся от webhook при остановке
            if (transport === "webhook" && maxChannelCfg?.webhookUrl) {
              unsubscribe(account.botToken, maxChannelCfg.webhookUrl).catch(() => {});
            }
            ctx.log?.info(`[max:${account.accountId}] MAX channel stopped.`);
            resolve();
          }, { once: true });
        }
      });
    },
  },
};

// ─── Re-export types needed by index.ts ──────────────────────────

export type { ResolvedMaxAccount };
