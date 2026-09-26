/**
 * Inbound pipeline: DM/group gates, agent routing and context, then the
 * reply dispatch (finalizeInboundContext → dispatchReplyWithBufferedBlockDispatcher).
 */

import { toInboundMediaFacts } from "openclaw/plugin-sdk/channel-inbound";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk/channel-outbound";

import type { MaxMessage, MaxUser } from "./api.js";
import { deliverMaxReply, withoutMaxButtons } from "./deliver.js";
import { collectInboundAttachments } from "./inbound-attachments.js";
import type { MaxMonitorOptions } from "./monitor-types.js";
import { materializeMaxPresentation } from "./presentation.js";
import { getMaxRuntime } from "./runtime.js";
import { readMaxChannelButtons, sendMaxMessage } from "./send.js";
import { createMaxDraftStream } from "./stream-draft.js";
import type { MaxMarkupElement } from "./types.js";

/**
 * Process incoming MAX message through OpenClaw pipeline (also the target of
 * synthesized /start and button-press messages).
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
  const isCallbackCommand = (message as MaxMessage & { __maxCallback?: boolean }).__maxCallback === true;
  const attachments = message.body.attachments ?? [];

  log?.debug?.(`[${account.accountId}] Processing message: mid=${messageId} chatId=${message.recipient.chat_id} chatType=${message.recipient.chat_type} senderId=${message.sender?.user_id} text="${rawText.slice(0, 50)}" attachments=${attachments.length}`);

  // Skip truly empty messages (no text and no attachment that yields media or
  // a description; inline keyboards yield neither). Attachments are
  // downloaded only after the DM/group gates below, so ignored group chatter
  // costs no traffic or disk.
  if (!rawText.trim() && !attachments.some((att) => att.type !== "inline_keyboard")) return;

  // Check for reply context
  const replyToId = message.link?.type === "reply" ? message.link.message?.body?.mid : undefined;

  // Check for bot mention in group chats
  let wasMentioned: boolean | undefined;
  if (isGroup && (opts.botUsername || opts.botUserId)) {
    // body.markup marks mentions as user_mention elements; the @botname regex
    // stays as a fallback for clients/messages that send no markup.
    wasMentioned = isBotMentionedInMarkup(message.body?.markup, opts.botUserId, opts.botUsername);
    if (!wasMentioned && opts.botUsername) {
      const mentionPattern = new RegExp(`@${escapeRegExp(opts.botUsername)}\\b`, "i");
      wasMentioned = mentionPattern.test(rawText);
    }

    // Reply to bot's message also counts as mention (like Telegram behavior)
    if (!wasMentioned && message.link?.type === "reply") {
      const replySender = message.link.sender;
      if (replySender?.is_bot && replySender?.user_id === opts.botUserId) {
        wasMentioned = true;
        log?.debug?.(`[${account.accountId}] Reply to bot message treated as mention`);
      }
    }
  }

  // Pressing a button on the bot's own keyboard is addressed to the bot, like a
  // reply to its message — don't drop it at the group mention gate.
  if (isGroup && isCallbackCommand) {
    wasMentioned = true;
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

  // Process attachments: download media, build descriptions for non-downloadable types
  const { descriptions: attachmentDescriptions, mediaInputs } = await collectInboundAttachments({
    attachments,
    messageId,
    chatId,
    api: opts.api,
    account,
    log,
  });

  const attachmentText = attachmentDescriptions.join(" ");
  const hasMedia = mediaInputs.length > 0;
  const effectiveText = rawText.trim() || attachmentText;

  // Nothing usable came out of the attachments (e.g. a failed sticker download)
  if (!effectiveText && !hasMedia) return;

  // Resolve agent route
  // chatIdStr stays the delivery address (MAX addresses replies by chat_id).
  const chatIdStr = String(chatId ?? senderId);
  // DM routing keys off the sender's user_id, not the dialog's chat_id: in MAX
  // the two differ, and bindings/allowFrom are expressed in user_id terms, so a
  // chat_id peer never matches. Groups keep chat_id — it is the group's own id.
  const routePeerId = isGroup ? chatIdStr : String(senderId ?? chatId);
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "max",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: routePeerId,
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
    // Media attachments (downloaded to local paths) as ordered media facts
    media: hasMedia ? toInboundMediaFacts(mediaInputs) : undefined,
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
  const replyMid = isCallbackCommand ? undefined : messageId.replace(/_edited_\d+$/, "");
  const callbackId = isCallbackCommand ? messageId : undefined;

  // Draft stream for edit-streaming (like Telegram's partial reply approach)
  const draft = createMaxDraftStream({ account, chatId: chatIdStr, replyToId: replyMid, log, statusSink });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (rawPayload) => {
        // This funnel consumes ReplyPayload directly, so it must apply the same
        // presentation fallback/render policy as core's outbound path.
        const payload = await materializeMaxPresentation(rawPayload);
        if (useEditStreaming && draft.messageId && payload.text) {
          await draft.finalize(payload.text, readMaxChannelButtons(payload.channelData));

          // Handle media if present (buttons already sit on the draft)
          if (payload.mediaUrls?.length || payload.mediaUrl) {
            await deliverMaxReply({
              payload: { ...payload, text: undefined, channelData: withoutMaxButtons(payload.channelData) },
              account,
              chatId: chatIdStr,
              replyToId: replyMid,
              callbackId,
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
          callbackId,
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
          if (payload.text) draft.update(payload.text);
        },
      } : {}),
      ...(useBlockStreaming ? { disableBlockStreaming: false } : {}),
    },
  });

  // Cleanup draft stream
  await draft.clear();
}

/**
 * Whether body.markup has a user_mention of this bot: by user_id (users
 * without a username) or by user_link `@username` (case-insensitive).
 * @internal exported for testing.
 */
export function isBotMentionedInMarkup(
  markup: MaxMarkupElement[] | null | undefined,
  botUserId?: number,
  botUsername?: string,
): boolean {
  if (!Array.isArray(markup)) return false;
  const username = botUsername?.replace(/^@/, "").toLowerCase();
  return markup.some((element) => {
    if (element?.type !== "user_mention") return false;
    if (botUserId != null && element.user_id === botUserId) return true;
    const link = typeof element.user_link === "string" ? element.user_link.replace(/^@/, "").toLowerCase() : "";
    return Boolean(username && link === username);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatSenderName(user?: MaxUser | null): string {
  if (!user) return "Unknown";
  const parts = [user.first_name];
  if (user.last_name) parts.push(user.last_name);
  return parts.join(" ") || user.username || `user_${user.user_id}`;
}
