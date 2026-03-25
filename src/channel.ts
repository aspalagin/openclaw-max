/**
 * MAX channel plugin — OpenClaw channel adapter
 * Uses types.ts + polling.ts from Банзай, api.ts + sender.ts from openclaw-max
 */
import {
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  emptyPluginConfigSchema,
  formatPairingApproveHint,
  mapAllowFromEntries,
} from "openclaw/plugin-sdk/nostr";
import {
  dispatchInboundDirectDmWithRuntime,
} from "openclaw/plugin-sdk/nostr";

import * as os from "node:os";
import * as path from "node:path";
import type { SendMessageBody } from "./api.js";
import { sendMessage } from "./api.js";
import { listMaxAccountIds, resolveDefaultMaxAccountId, resolveMaxAccount } from "./config.js";
import { downloadAttachment } from "./media.js";
import { startPolling } from "./polling.js";
import { editText, removeMessage, sendLocalFile, sendText } from "./sender.js";
import type {
  Attachment,
  AudioAttachment,
  FileAttachment,
  Message,
  MessageCreatedUpdate,
  PhotoAttachment,
  ResolvedMaxAccount,
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

// ─── Streaming: track preview message IDs ─────────────────────────

const streamingMessages = new Map<string, string>();

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
    chatTypes: ["direct"],
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
      mediaUrl,
    }: {
      cfg: Record<string, unknown>;
      to: string;
      text?: string | null;
      accountId?: string | null;
      mediaUrl?: string | null;
    }) => {
      const account = resolveMaxAccount({ cfg, accountId });
      if (!account.configured) {
        throw new Error(`MAX account ${account.accountId} not configured`);
      }

      const chatId = Number(to);
      if (isNaN(chatId)) throw new Error(`Invalid MAX chat_id: ${to}`);

      // File send path
      if (mediaUrl && !mediaUrl.startsWith("http")) {
        try {
          const msgId = await sendLocalFile(account.botToken, chatId, mediaUrl, text ?? undefined);
          return { channel: "max" as const, to, messageId: msgId };
        } catch {
          // Fall through to text
        }
      }

      const msgId = await sendText(account.botToken, chatId, text ?? "");
      return { channel: "max" as const, to, messageId: msgId };
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
    }: {
      cfg: Record<string, unknown>;
      to: string;
      text: string;
      accountId?: string | null;
      sessionKey?: string | null;
    }) => {
      const account = resolveMaxAccount({ cfg, accountId });
      if (!account.configured) return;
      const chatId = Number(to);
      if (isNaN(chatId)) return;

      const key = sessionKey ?? `${account.accountId}:${to}`;
      const existingId = streamingMessages.get(key);

      try {
        if (existingId) {
          await editText(account.botToken, existingId, text + " ▍");
        } else {
          const msgId = await sendText(account.botToken, chatId, text + " ▍");
          streamingMessages.set(key, msgId);
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
      const chatId = Number(to);
      if (isNaN(chatId)) return;

      const key = sessionKey ?? `${account.accountId}:${to}`;
      const existingId = streamingMessages.get(key);
      streamingMessages.delete(key);

      try {
        if (existingId) {
          await editText(account.botToken, existingId, text);
        } else {
          await sendText(account.botToken, chatId, text);
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
    startAccount: (ctx: {
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

      ctx.log?.info(`[max:${account.accountId}] Starting MAX channel (long polling)...`);

      if (!account.configured) {
        throw new Error("MAX bot token not configured");
      }

      // channelRuntime is passed by gateway as createPluginRuntime().channel
      // It contains reply.dispatchInboundMessageWithBufferedDispatcher etc.
      const rt = (ctx.channelRuntime ?? _runtime) as {
        reply?: {
          dispatchInboundMessageWithBufferedDispatcher?: (params: unknown) => Promise<void>;
          handleInboundMessage?: (params: unknown) => Promise<void>;
        };
      } | null;

      // Return a Promise that stays alive until abortSignal fires or polling ends
      return new Promise<void>((resolve) => {
        const stopPolling = startPolling(
          account.botToken,
          async (update: MessageCreatedUpdate) => {
            const msg = update.message;
            const senderId = String(msg.sender?.user_id ?? 0);
            const chatId = resolveChatId(msg);
            const text = msg.body.text ?? "";
            const attachments = msg.body.attachments ?? [];

            ctx.log?.info?.(
              `[max:${account.accountId}] from=${senderId} chat=${chatId} text="${text.slice(0, 60)}"`,
            );

            // Download attachments to local media/inbound dir
            const attRefs = extractAttachmentRefs(attachments);
            const localFiles = await downloadAttachments(
              attRefs,
              account.botToken,
              account.accountId,
              ctx.log,
            );

            // Use SDK pipeline to route and dispatch inbound message
            const cfg = ((_runtime as any)?.config?.loadConfig?.() ?? {}) as Record<string, unknown>;

            try {
              ctx.log?.info?.(`[max:${account.accountId}] dispatching from=${senderId} chat=${chatId}`);

              await dispatchInboundDirectDmWithRuntime({
                cfg: cfg as any,
                channel: "max",
                channelLabel: "max",
                accountId: account.accountId,
                peer: { kind: "direct" as const, id: senderId },
                senderAddress: senderId,
                recipientAddress: account.accountId,
                senderId,
                conversationLabel: `MAX DM ${senderId}`,
                rawBody: text,
                bodyForAgent: text,
                commandBody: text,
                messageId: String(Date.now()),
                timestamp: Date.now(),
                commandAuthorized: true,
                provider: "max",
                surface: "max",
                runtime: _runtime as any,
                extraContext: {
                  MediaPath: localFiles.length > 0 ? localFiles[0] : undefined,
                  MediaPaths: localFiles.length > 0 ? localFiles : undefined,
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
          },
          { types: ["message_created"] },
        );

        activeStopFns.set(account.accountId, stopPolling);
        ctx.log?.info(`[max:${account.accountId}] MAX channel started.`);

        // When gateway signals abort — stop polling and resolve (clean shutdown)
        if (ctx.abortSignal) {
          ctx.abortSignal.addEventListener("abort", () => {
            stopPolling();
            activeStopFns.delete(account.accountId);
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
