/**
 * MAX long-polling monitor — receives updates and dispatches them to OpenClaw.
 *
 * Uses the same inbound pipeline as other channel plugins:
 * finalizeInboundContext → dispatchReplyWithBufferedBlockDispatcher
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ChannelLogSink } from "openclaw/plugin-sdk/channel-runtime";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk/channel-runtime";
import { MaxApi, type MaxUpdate, type MaxMessage, type MaxUser, type MaxCallback } from "./api.js";
import { resolveMaxAccount, type ResolvedMaxAccount } from "./accounts.js";
import { sendMaxMessage, sendMaxMediaMessage, editMaxMessage } from "./send.js";
import { getMaxRuntime } from "./runtime.js";
import { rememberStickerCode } from "./sticker-cache.js";
import {
  registerMaxWebhookTarget,
  resolveMaxWebhookPath,
  subscribeMaxWebhook,
  unsubscribeMaxWebhook,
  type MaxWebhookTarget,
} from "./webhook.js";

export interface MaxMonitorOptions {
  api: MaxApi;
  account: ResolvedMaxAccount;
  config: OpenClawConfig;
  abortSignal: AbortSignal;
  botUserId?: number;
  botUsername?: string;
  log?: ChannelLogSink;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}

export async function startMaxPolling(opts: MaxMonitorOptions): Promise<void> {
  const { api, account, config, abortSignal, log, statusSink } = opts;
  
  // Check if webhook mode is configured
  const webhookUrl = account.config.webhookUrl?.trim();
  const useWebhook = Boolean(webhookUrl);

  if (useWebhook) {
    // Webhook mode
    await startMaxWebhook({ ...opts, webhookUrl: webhookUrl! });
  } else {
    // Polling mode
    await startMaxPollingLoop(opts);
  }
}

async function startMaxPollingLoop(opts: MaxMonitorOptions): Promise<void> {
  const { api, account, config, abortSignal, log, statusSink } = opts;
  let marker: number | null = null;

  log?.info(`[${account.accountId}] MAX long-polling started`);

  while (!abortSignal.aborted) {
    try {
      const resp = await api.getUpdates({
        timeout: 30,
        marker: marker ?? undefined,
        types: [
          "message_created",
          "message_callback",
          "message_edited",
          "message_removed",
          "message_reaction_created",
          "message_reaction_updated",
          "bot_started",
          "bot_added",
          "bot_removed",
        ],
      });

      if (resp.marker != null) {
        marker = resp.marker;
      }

      for (const update of resp.updates) {
        if (abortSignal.aborted) break;
        try {
          await dispatchUpdate(update, opts);
        } catch (err) {
          log?.error(`[${account.accountId}] Error dispatching update ${update.update_type}: ${String(err)}`);
        }
      }
    } catch (err) {
      if (abortSignal.aborted) break;
      log?.error(`[${account.accountId}] Polling error: ${String(err)}`);
      // Back off on error
      await sleep(3000);
    }
  }

  log?.info(`[${account.accountId}] MAX long-polling stopped`);
}

async function startMaxWebhook(opts: MaxMonitorOptions & { webhookUrl: string }): Promise<void> {
  const { api, account, config, abortSignal, log, statusSink, webhookUrl } = opts;
  
  const webhookPath = resolveMaxWebhookPath(
    account.config.webhookPath,
    account.config.webhookUrl,
  );
  const webhookSecret = account.config.webhookSecret?.trim();

  log?.info(`[${account.accountId}] MAX webhook mode: ${webhookUrl} (path: ${webhookPath})`);

  // Register webhook handler
  const target: MaxWebhookTarget = {
    account,
    config,
    path: webhookPath,
    secret: webhookSecret,
    onUpdate: async (update) => {
      try {
        await dispatchUpdate(update, opts);
      } catch (err) {
        log?.error(`[${account.accountId}] Webhook update dispatch failed: ${String(err)}`);
      }
    },
    log: (msg) => log?.info?.(msg),
    error: (msg) => log?.error?.(msg),
  };

  const unregister = registerMaxWebhookTarget(target);

  // Subscribe to webhook
  try {
    await subscribeMaxWebhook({
      api,
      webhookUrl,
      secret: webhookSecret,
    });
    log?.info(`[${account.accountId}] MAX webhook subscribed: ${webhookUrl}`);
  } catch (err) {
    log?.error(`[${account.accountId}] MAX webhook subscription failed: ${String(err)}`);
    unregister();
    throw err;
  }

  // Wait for abort signal
  await new Promise<void>((resolve) => {
    const checkAbort = () => {
      if (abortSignal.aborted) {
        resolve();
      } else {
        setTimeout(checkAbort, 1000);
      }
    };
    checkAbort();
  });

  // Unsubscribe on stop
  try {
    await unsubscribeMaxWebhook({ api, webhookUrl });
    log?.info(`[${account.accountId}] MAX webhook unsubscribed`);
  } catch (err) {
    log?.error(`[${account.accountId}] MAX webhook unsubscribe failed: ${String(err)}`);
  }

  unregister();
  log?.info(`[${account.accountId}] MAX webhook mode stopped`);
}

// ── Dispatch ──

async function dispatchUpdate(
  update: MaxUpdate,
  opts: MaxMonitorOptions,
): Promise<void> {
  const { log, account, statusSink } = opts;

  switch (update.update_type) {
    case "message_created": {
      if (!update.message) break;
      // Skip messages from the bot itself
      if (opts.botUserId && update.message.sender?.user_id === opts.botUserId) break;
      statusSink?.({ lastInboundAt: Date.now() });
      // Mark message as read + show typing indicator
      const chatIdForRead = update.message.recipient?.chat_id;
      if (chatIdForRead) {
        opts.api.sendAction(chatIdForRead, "mark_seen").catch((err) => {
          log?.debug?.(`[${account.accountId}] mark_seen failed: ${String(err)}`);
        });
        opts.api.sendAction(chatIdForRead, "typing_on").catch((err) => {
          log?.debug?.(`[${account.accountId}] typing_on failed: ${String(err)}`);
        });
      }
      await processIncomingMessage(update.message, update.user_locale, opts);
      break;
    }

    case "message_callback": {
      if (!update.callback) break;
      statusSink?.({ lastInboundAt: Date.now() });
      await processCallback(update.callback, opts);
      break;
    }

    case "message_edited": {
      if (!update.message) break;
      // Skip edits from the bot itself
      if (opts.botUserId && update.message.sender?.user_id === opts.botUserId) break;
      log?.debug?.(`[${account.accountId}] Message edited: ${update.message?.body?.mid} text="${update.message?.body?.text ?? "<null>"}" hasBody=${!!update.message?.body}`);
      statusSink?.({ lastInboundAt: Date.now() });
      // Mark as read + show typing indicator
      const chatIdForEditRead = update.message.recipient?.chat_id;
      if (chatIdForEditRead) {
        opts.api.sendAction(chatIdForEditRead, "mark_seen").catch((err) => {
          log?.debug?.(`[${account.accountId}] mark_seen failed: ${String(err)}`);
        });
        opts.api.sendAction(chatIdForEditRead, "typing_on").catch((err) => {
          log?.debug?.(`[${account.accountId}] typing_on failed: ${String(err)}`);
        });
      }
      // Process edited message through the same pipeline as new messages.
      // Use a unique mid suffix to avoid OpenClaw dedup (same mid = skipped).
      const editedMessage = { ...update.message };
      const originalMid = editedMessage.body.mid;
      editedMessage.body = {
        ...editedMessage.body,
        mid: `${originalMid}_edited_${update.timestamp}`,
      };

      // MAX message_edited may not include text — fetch it from API if missing
      if (!editedMessage.body.text?.trim() && originalMid) {
        try {
          const chatId = editedMessage.recipient?.chat_id;
          if (chatId) {
            const fetched = await opts.api.getMessages(chatId, { message_ids: [originalMid], count: 1 });
            const fetchedMsg = fetched.messages?.[0];
            if (fetchedMsg?.body?.text) {
              editedMessage.body = { ...editedMessage.body, text: fetchedMsg.body.text };
              if (fetchedMsg.body.attachments?.length) {
                editedMessage.body.attachments = fetchedMsg.body.attachments;
              }
              log?.debug?.(`[${account.accountId}] Fetched edited text: "${fetchedMsg.body.text.slice(0, 50)}"`);
            }
          }
        } catch (err) {
          log?.debug?.(`[${account.accountId}] Failed to fetch edited message text: ${String(err)}`);
        }
      }

      await processIncomingMessage(editedMessage, update.user_locale, opts);
      break;
    }

    case "bot_started": {
      if (!update.user) break;
      log?.info(`[${account.accountId}] Bot started by user ${update.user.user_id}`);
      statusSink?.({ lastInboundAt: Date.now() });
      await processBotStarted(update.user, update.chat_id, opts);
      break;
    }

    case "bot_added": {
      log?.info(`[${account.accountId}] Bot added to chat ${update.chat_id}`);
      break;
    }

    case "bot_removed": {
      log?.info(`[${account.accountId}] Bot removed from chat ${update.chat_id}`);
      break;
    }

    default:
      log?.debug?.(`[${account.accountId}] Unhandled update type: ${update.update_type}`);
  }
}

// ── Process messages through OpenClaw pipeline ──

/**
 * Process incoming MAX message through OpenClaw pipeline.
 * @internal - Exported for testing only
 */
export async function processIncomingMessage(
  message: MaxMessage,
  userLocale: string | null | undefined,
  opts: MaxMonitorOptions,
): Promise<void> {
  const { account, config, log, statusSink } = opts;
  const core = getMaxRuntime();

  const senderId = message.sender?.user_id;
  const senderName = formatSenderName(message.sender);
  const senderUsername = message.sender?.username ?? undefined;

  // Determine chat type and IDs
  const chatId = message.recipient.chat_id;
  const chatType = message.recipient.chat_type; // "dialog", "chat", "channel"
  const isGroup = chatType === "chat" || chatType === "channel";

  const rawText = message.body.text ?? "";
  const messageId = message.body.mid;
  const attachments = message.body.attachments ?? [];

  log?.debug?.(`[${account.accountId}] Processing message: mid=${messageId} chatId=${message.recipient.chat_id} chatType=${message.recipient.chat_type} senderId=${message.sender?.user_id} text="${rawText.slice(0, 50)}" attachments=${attachments.length}`);

  // Process attachments: download media, build descriptions for non-downloadable types
  const attachmentDescriptions: string[] = [];
  const mediaPaths: string[] = [];
  const mediaUrls: string[] = [];
  const mediaTypes: string[] = [];

  for (const att of attachments) {
    const attType = att.type ?? "unknown";
    const payload = att.payload as Record<string, unknown> | undefined;

    // Media types with downloadable URL: image, sticker, video, audio, file
    if (["image", "sticker", "video", "audio", "file"].includes(attType)) {
      // For stickers, always capture the code for outbound use
      const stickerCode = attType === "sticker" ? ((payload?.code ?? "") as string) : "";
      if (stickerCode) {
        log?.debug?.(`[${account.accountId}] Sticker received: code=${stickerCode}`);
        attachmentDescriptions.push(`[Sticker: code=${stickerCode}]`);
        if (chatId != null) {
          rememberStickerCode(chatId, stickerCode);
        }
      }

      const url = (payload?.url ?? (att as Record<string, unknown>).url ?? "") as string;
      if (url && typeof url === "string" && url.startsWith("http")) {
        try {
          const maxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
          const fetched = await core.channel.media.fetchRemoteMedia({ url, maxBytes });
          const saved = await core.channel.media.saveMediaBuffer(
            Buffer.from(fetched.buffer),
            fetched.contentType,
            "inbound",
            maxBytes,
            fetched.fileName,
          );
          mediaPaths.push(saved.path);
          mediaUrls.push(saved.path);
          if (saved.contentType) mediaTypes.push(saved.contentType);
        } catch (err) {
          log?.error?.(`[${account.accountId}] Failed to download ${attType}: ${String(err)}`);
          // Fall back to text description (sticker code already added above)
          if (attType !== "sticker") {
            attachmentDescriptions.push(`[${attType}: ${url}]`);
          }
        }
      } else {
        // No URL — text description
        if (attType === "sticker") {
          const code = payload?.code ?? "";
          attachmentDescriptions.push(`[Sticker${code ? `: ${code}` : ""}]`);
        } else if (attType === "file") {
          const filename = (att as Record<string, unknown>).filename ?? payload?.filename ?? "";
          attachmentDescriptions.push(`[File${filename ? `: ${filename}` : ""}]`);
        } else {
          attachmentDescriptions.push(`[${attType}]`);
        }
      }
    } else if (attType === "share") {
      const url = (payload?.url ?? (att as Record<string, unknown>).url ?? "") as string;
      attachmentDescriptions.push(`[Share${url ? `: ${url}` : ""}]`);
    } else if (attType === "location") {
      const lat = (att as Record<string, unknown>).latitude ?? payload?.latitude ?? "";
      const lon = (att as Record<string, unknown>).longitude ?? payload?.longitude ?? "";
      attachmentDescriptions.push(`[Location: ${lat}, ${lon}]`);
    } else if (attType === "contact") {
      const name = payload?.name ?? payload?.vcf_info ?? "";
      attachmentDescriptions.push(`[Contact${name ? `: ${name}` : ""}]`);
    } else if (attType !== "inline_keyboard") {
      attachmentDescriptions.push(`[${attType}]`);
    }
  }

  const attachmentText = attachmentDescriptions.join(" ");
  const hasMedia = mediaPaths.length > 0;
  const effectiveText = rawText.trim() || attachmentText;

  // Skip truly empty messages (no text, no media, no meaningful attachments)
  if (!effectiveText && !hasMedia) return;

  // Check for reply context
  const replyToId = message.link?.type === "reply" ? message.link.message?.body?.mid : undefined;

  // Check for bot mention in group chats
  let wasMentioned: boolean | undefined;
  if (isGroup && opts.botUsername) {
    // MAX doesn't have annotation-based mentions like Google Chat,
    // so we check if the text contains @botname
    const mentionPattern = new RegExp(`@${opts.botUsername}\\b`, "i");
    wasMentioned = mentionPattern.test(rawText);

    // Reply to bot's message also counts as mention (like Telegram behavior)
    if (!wasMentioned && message.link?.type === "reply") {
      const replySender = message.link.sender;
      if (replySender?.is_bot && replySender?.user_id === opts.botUserId) {
        wasMentioned = true;
        log?.debug?.(`[${account.accountId}] Reply to bot message treated as mention`);
      }
    }
  }

  // DM security: check pairing/allowlist
  if (!isGroup) {
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    if (dmPolicy === "disabled") {
      log?.debug?.(`[${account.accountId}] Blocked DM from ${senderId} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== "open") {
      const configAllowFrom = (account.config.allowFrom ?? []).map(String);
      const storeAllowFrom = await core.channel.pairing.readAllowFromStore({ channel: "max", accountId: account.accountId }).catch(() => []);
      const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];

      const senderStr = String(senderId);
      const allowed = effectiveAllowFrom.includes(senderStr) || effectiveAllowFrom.includes("*");

      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "max",
            id: senderStr,
            accountId: account.accountId,
            meta: { name: senderName },
          });
          if (created) {
            log?.info(`[${account.accountId}] Pairing request from ${senderStr}`);
            try {
              const pairingReply = core.channel.pairing.buildPairingReply({
                channel: "max",
                idLine: `Your MAX user id: ${senderStr}`,
                code,
              });
              await sendMaxMessage(String(chatId ?? senderId), pairingReply, {
                token: account.token,
              });
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              log?.error(`[${account.accountId}] Pairing reply failed: ${String(err)}`);
            }
          }
        }
        return;
      }
    }
  }

  // Group policy
  if (isGroup) {
    const defaultGroupPolicy = config.channels?.defaults?.groupPolicy;
    const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";

    if (groupPolicy === "disabled") {
      log?.debug?.(`[${account.accountId}] Blocked group message (groupPolicy=disabled)`);
      return;
    }

    // For allowlist policy, check if chat is in the groups config
    if (groupPolicy === "allowlist") {
      const groups = account.config.groups ?? {};
      const chatIdStr = String(chatId);
      const hasWildcard = "*" in groups;
      const chatAllowed = chatIdStr in groups || hasWildcard;
      if (!chatAllowed) {
        log?.debug?.(`[${account.accountId}] Blocked group message (not in allowlist, chat=${chatIdStr})`);
        return;
      }
    }

    // Require mention in groups
    const groupCfg = account.config.groups?.[String(chatId)] ?? account.config.groups?.["*"];
    const requireMention = groupCfg?.requireMention ?? true;
    if (requireMention && !wasMentioned) {
      log?.debug?.(`[${account.accountId}] Skipping group message (not mentioned)`);
      return;
    }
  }

  // Resolve agent route
  const chatIdStr = String(chatId ?? senderId);
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "max",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: chatIdStr,
    },
  });

  // Build context
  const fromLabel = isGroup
    ? `chat:${chatIdStr}`
    : senderName || `user:${senderId}`;

  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // Combine text and attachment descriptions for the agent
  const bodyForAgent = attachmentText
    ? rawText.trim()
      ? `${rawText.trim()}\n${attachmentText}`
      : attachmentText
    : rawText;

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "MAX",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: bodyForAgent,
  });

  // Detect text-slash commands (user types /status, /models, /reasoning etc.)
  const rawTextTrimmed = (rawText || "").trim();
  const isTextSlashCommand = rawTextTrimmed.startsWith("/");

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: bodyForAgent,
    RawBody: rawText,
    CommandBody: rawText || attachmentText,
    From: `max:${senderId}`,
    To: `max:${chatIdStr}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId != null ? String(senderId) : undefined,
    SenderUsername: senderUsername,
    WasMentioned: isGroup ? wasMentioned : undefined,
    Provider: "max",
    Surface: "max",
    MessageSid: messageId,
    MessageSidFull: messageId,
    ReplyToId: replyToId,
    ReplyToIdFull: replyToId,
    OriginatingChannel: "max",
    OriginatingTo: `max:${chatIdStr}`,
    // Media attachments (downloaded to local paths)
    MediaPath: mediaPaths[0],
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrl: mediaUrls[0],
    MediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    MediaType: mediaTypes[0],
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
    // Text-slash command detection: treat /status, /models etc. as text commands
    // so OpenClaw routes them through handleCommands instead of silently dropping
    ...(isTextSlashCommand ? {
      CommandSource: "text" as const,
      CommandTurn: {
        kind: "text-slash" as const,
        source: "text" as const,
        authorized: undefined, // let allowFrom resolve authorization
        body: rawTextTrimmed,
      },
    } : {}),
  });

  // Record session meta
  void core.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      log?.error(`[${account.accountId}] Failed updating session meta: ${String(err)}`);
    });

  // Dispatch through the standard reply pipeline
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "max",
    accountId: route.accountId,
  });

  // Send typing indicator while agent processes
  if (chatId != null) {
    opts.api.sendAction(chatId, "typing_on").catch((err) => {
      log?.debug?.(`[${account.accountId}] typing_on failed: ${String(err)}`);
    });
  }

  // Streaming modes: "partial" = edit single message, "block" = each block as separate message
  const streamMode = account.config.streamMode ?? "off";
  const useEditStreaming = streamMode === "partial";
  const useBlockStreaming = streamMode === "block";
  const replyMid = messageId.replace(/_edited_\d+$/, "");

  // Draft stream for edit-streaming (like Telegram's partial reply approach)
  let draftMid: string | null = null;
  let draftLastText = "";
  let draftLastEditAt = 0;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let draftStopped = false;
  const DRAFT_THROTTLE_MS = 1200;
  const DRAFT_MAX_CHARS = 4000;
  const DRAFT_MIN_CHARS = 30; // Don't send until we have enough text

  const draftUpdate = async (text: string) => {
    if (draftStopped || !text) return;
    const trimmed = text.trimEnd();
    if (!trimmed || trimmed === draftLastText) return;
    if (trimmed.length > DRAFT_MAX_CHARS) {
      draftStopped = true;
      return;
    }
    if (!draftMid && trimmed.length < DRAFT_MIN_CHARS) return; // wait for more text

    // Clear pending timer
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }

    const now = Date.now();
    const elapsed = now - draftLastEditAt;
    if (elapsed < DRAFT_THROTTLE_MS) {
      // Schedule a deferred update
      draftTimer = setTimeout(() => { draftUpdate(text); }, DRAFT_THROTTLE_MS - elapsed);
      return;
    }

    draftLastText = trimmed;
    draftLastEditAt = now;

    try {
      if (!draftMid) {
        // First chunk — send new message
        const res = await sendMaxMessage(chatIdStr, trimmed, {
          token: account.token,
          replyToMessageId: replyMid,
          format: "markdown",
        });
        draftMid = res.messageId || null;
        statusSink?.({ lastOutboundAt: Date.now() });
      } else {
        // Edit existing message
        await editMaxMessage(draftMid, trimmed, {
          token: account.token,
          format: "markdown",
        });
      }
    } catch (err) {
      draftStopped = true;
      log?.debug?.(`[${account.accountId}] MAX draft stream failed: ${String(err)}`);
    }
  };

  const draftFlush = async () => {
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
    if (!draftLastText) return;
    // no-op if nothing changed
  };

  const draftClear = async () => {
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
    draftStopped = true;
  };

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload) => {
        if (useEditStreaming && draftMid && payload.text) {
          // Final delivery replaces the draft message with final text
          const finalText = payload.text;
          if (finalText !== draftLastText) {
            try {
              await editMaxMessage(draftMid, finalText, {
                token: account.token,
                format: "markdown",
              });
              draftLastText = finalText;
            } catch (_) { /* best effort */ }
          }
          draftStopped = true;

          // Handle media if present
          if (payload.mediaUrls?.length || payload.mediaUrl) {
            await deliverMaxReply({
              payload: { ...payload, text: undefined },
              account,
              chatId: chatIdStr,
              replyToId: replyMid,
              config,
              log,
              statusSink,
            });
          }
          return;
        }

        // Non-streaming path or no draft yet
        await deliverMaxReply({
          payload,
          account,
          chatId: chatIdStr,
          replyToId: replyMid,
          config,
          log,
          statusSink,
        });
      },
      onError: (err, info) => {
        log?.error(`[${account.accountId}] MAX ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
      ...(useEditStreaming ? {
        onPartialReply: (payload: { text?: string }) => {
          if (payload.text) draftUpdate(payload.text);
        },
      } : {}),
      ...(useBlockStreaming ? { disableBlockStreaming: false } : {}),
    },
  });

  // Cleanup draft stream
  await draftClear();
}

async function processCallback(
  callback: MaxCallback,
  opts: MaxMonitorOptions,
): Promise<void> {
  const payload = callback.payload ?? "";
  if (!payload.trim()) return;

  // Synthesize as a regular message
  const syntheticMessage: MaxMessage = {
    sender: callback.user,
    recipient: callback.message?.recipient ?? { chat_id: callback.user.user_id },
    timestamp: callback.timestamp,
    body: {
      mid: callback.callback_id,
      text: payload,
    },
  };

  await processIncomingMessage(syntheticMessage, null, opts);
}

async function processBotStarted(
  user: MaxUser,
  chatId: number | undefined,
  opts: MaxMonitorOptions,
): Promise<void> {
  // Synthesize a /start message
  const syntheticMessage: MaxMessage = {
    sender: user,
    recipient: { chat_id: chatId ?? user.user_id, chat_type: "dialog" },
    timestamp: Date.now(),
    body: {
      mid: `bot_started_${user.user_id}_${Date.now()}`,
      text: "/start",
    },
  };

  await processIncomingMessage(syntheticMessage, null, opts);
}

// ── Deliver reply ──

async function deliverMaxReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string; replyToId?: string };
  account: ResolvedMaxAccount;
  chatId: string;
  replyToId?: string;
  config: OpenClawConfig;
  log?: ChannelLogSink;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, account, chatId, config, log, statusSink } = params;
  const core = getMaxRuntime();

  if (payload.text) {
    const chunkLimit = 4000; // MAX message limit
    const chunkMode = core.channel.text.resolveChunkMode(config, "max", account.accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(payload.text, chunkLimit, chunkMode);

    for (const chunk of chunks) {
      try {
        await sendMaxMessage(chatId, chunk, {
          token: account.token,
          replyToMessageId: params.replyToId,
          format: "markdown",
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err: unknown) {
        const body = (err as { body?: unknown })?.body;
        log?.error(`[${account.accountId}] MAX send failed: ${String(err)}${body ? ` body=${JSON.stringify(body)}` : ""}`);
      }
    }
  }

  // Media URLs — upload and send
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  for (const mediaUrl of mediaList) {
    try {
      // Download media first if it's a URL
      if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
        const maxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
        const loaded = await core.channel.media.fetchRemoteMedia({ url: mediaUrl, maxBytes });
        
        // Write to temp file
        const fs = await import("fs/promises");
        const tmpPath = `/tmp/max-media-${Date.now()}-${loaded.fileName ?? "file"}`;
        await fs.writeFile(tmpPath, loaded.buffer);
        
        try {
          await sendMaxMediaMessage(chatId, "", tmpPath, {
            token: account.token,
            replyToMessageId: params.replyToId,
          });
          statusSink?.({ lastOutboundAt: Date.now() });
        } finally {
          // Cleanup temp file
          await fs.unlink(tmpPath).catch(() => {});
        }
      } else {
        // Local file path
        await sendMaxMediaMessage(chatId, "", mediaUrl, {
          token: account.token,
          replyToMessageId: params.replyToId,
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      }
    } catch (err) {
      log?.error(`[${account.accountId}] MAX media send failed: ${String(err)}`);
    }
  }
}

// ── Helpers ──

function formatSenderName(user?: MaxUser | null): string {
  if (!user) return "Unknown";
  const parts = [user.first_name];
  if (user.last_name) parts.push(user.last_name);
  return parts.join(" ") || user.username || `user_${user.user_id}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
