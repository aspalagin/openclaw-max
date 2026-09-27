/**
 * Inbound pipeline: DM/group gates, agent routing and context, then the
 * reply dispatch (finalizeInboundContext → dispatchReplyWithBufferedBlockDispatcher).
 */

import { matchesMentionPatterns, toInboundMediaFacts } from 'openclaw/plugin-sdk/channel-inbound';
import {
  createReplyPrefixOptions,
  resolveChannelPreviewStreamMode,
} from 'openclaw/plugin-sdk/channel-outbound';
import { getAgentScopedMediaLocalRoots } from 'openclaw/plugin-sdk/media-local-roots';

import { admitMaxGroupChat, admitMaxGroupSender, readMaxDmAllowFrom } from './access-policy.js';
import type { ResolvedMaxAccount } from './accounts.js';
import type { MaxAttachment, MaxLinkedMessage, MaxMessage, MaxUser } from './api.js';
import { resolveMaxCommandMenu } from './command-menu.js';
import { deliverMaxReply } from './deliver.js';
import {
  echoMaxVoiceTranscript,
  type MaxVoiceMention,
  resolveMaxMentionRegexes,
  resolveMaxVoiceMention,
} from './group-mention.js';
import { collectInboundAttachments, resolveInboundMediaMaxCount } from './inbound-attachments.js';
import type { MaxMonitorOptions } from './monitor-types.js';
import { materializeMaxPresentation } from './presentation.js';
import { createMaxProgressDraft } from './progress-draft.js';
import { getMaxRuntime } from './runtime.js';
import { sendMaxMessage } from './send.js';
import { createMaxDraftStream } from './stream-draft.js';
import { maxTurnAdoptionReplyOptions } from './turn-adoption.js';
import type { MaxMarkupElement } from './types.js';
import { createMaxTypingCallbacks } from './typing.js';

/** Characters of message text in debug logs with logMessagePreview on. */
const LOG_PREVIEW_CHARS = 50;

/**
 * Message text as logs may show it: its length only, unless the account
 * enables logMessagePreview (a short preview for debugging).
 */
export function describeMaxLogText(
  account: ResolvedMaxAccount,
  text: string | null | undefined,
): string {
  const length = text?.length ?? 0;
  if (account.config.logMessagePreview !== true || !text) return `textLength=${length}`;
  return `text="${text.slice(0, LOG_PREVIEW_CHARS)}" textLength=${length}`;
}

/** Longest quote of a replied-to message handed to the agent. */
const MAX_REPLY_QUOTE_CHARS = 1000;

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
  const isGroup = chatType === 'chat' || chatType === 'channel';

  // body is null when the message is only a forward; the content then lives
  // in link.message. Such a message has no mid of its own: a stable synthetic
  // id keeps redelivery dedup working, and replies go out without a link.
  const messageBody = message.body ?? undefined;
  const rawText = messageBody?.text ?? '';
  const messageId =
    messageBody?.mid ??
    `link_${chatId ?? senderId}_${message.timestamp}_${message.link?.message?.mid ?? ''}`;
  const isCallbackCommand =
    (message as MaxMessage & { __maxCallback?: boolean }).__maxCallback === true;
  const isCommandMenuPress =
    isCallbackCommand &&
    (message as MaxMessage & { __maxCommandMenu?: boolean }).__maxCommandMenu === true;
  const attachments = messageBody?.attachments ?? [];
  const forward = readForwardedMessage(message.link);

  log?.debug?.(
    `[${account.accountId}] Processing message: mid=${messageId} chatId=${message.recipient.chat_id} chatType=${message.recipient.chat_type} senderId=${message.sender?.user_id} ${describeMaxLogText(account, rawText)} attachments=${attachments.length}`,
  );

  // Skip truly empty messages (no text and no attachment that yields media or
  // a description; inline keyboards yield neither), counting forwarded
  // content. Attachments are downloaded only after the DM/group gates below,
  // so ignored group chatter costs no traffic or disk.
  if (
    !rawText.trim() &&
    !hasAgentAttachments(attachments) &&
    !(forward && (forward.text.trim() || hasAgentAttachments(forward.attachments)))
  ) {
    // A message with no text and no attachments at all is what some clients
    // reportedly get in long polling for a voice message: leave a trace.
    if (!attachments.length && !forward && !isCallbackCommand) {
      log?.info?.(
        `[${account.accountId}] Skipping empty message ${messageId}: no text, attachments or forward`,
      );
    }
    return;
  }

  // Check for reply context (link.message is the replied-to MessageBody)
  const reply = message.link?.type === 'reply' ? message.link : undefined;
  const replyToId = reply?.message?.mid ?? undefined;

  // Resolve agent route (before the mention check: configured mention
  // patterns may be the routed agent's own).
  // chatIdStr stays the delivery address (MAX addresses replies by chat_id).
  const chatIdStr = String(chatId ?? senderId);
  // DM routing keys off the sender's user_id, not the dialog's chat_id: in MAX
  // the two differ, and bindings/allowFrom are expressed in user_id terms, so a
  // chat_id peer never matches. Groups keep chat_id — it is the group's own id.
  const routePeerId = isGroup ? chatIdStr : String(senderId ?? chatId);
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: 'max',
    accountId: account.accountId,
    peer: {
      kind: isGroup ? 'group' : 'direct',
      id: routePeerId,
    },
  });

  // Check for bot mention in group chats
  let wasMentioned: boolean | undefined;
  const mentionRegexes = isGroup
    ? resolveMaxMentionRegexes({ cfg: config, agentId: route.agentId, account, chatId: chatIdStr })
    : [];
  if (isGroup && (opts.botUsername || opts.botUserId || mentionRegexes.length > 0)) {
    // body.markup marks mentions as user_mention elements; the @botname regex
    // stays as a fallback for clients/messages that send no markup.
    wasMentioned = isBotMentionedInMarkup(message.body?.markup, opts.botUserId, opts.botUsername);
    if (!wasMentioned && opts.botUsername) {
      const mentionPattern = new RegExp(`@${escapeRegExp(opts.botUsername)}\\b`, 'i');
      wasMentioned = mentionPattern.test(rawText);
    }
    // Core mention patterns (messages.groupChat / agent groupChat), only when
    // configured; the sender's own text, not forwarded content.
    if (!wasMentioned && mentionRegexes.length > 0) {
      wasMentioned = matchesMentionPatterns(rawText, mentionRegexes);
    }

    // Reply to bot's message also counts as mention (like Telegram behavior)
    if (!wasMentioned && message.link?.type === 'reply') {
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
    const dmPolicy = account.config.dmPolicy ?? 'pairing';
    if (dmPolicy === 'disabled') {
      log?.debug?.(`[${account.accountId}] Blocked DM from ${senderId} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== 'open') {
      const effectiveAllowFrom = await readMaxDmAllowFrom(account);

      const senderStr = String(senderId);
      const allowed = effectiveAllowFrom.includes(senderStr) || effectiveAllowFrom.includes('*');

      if (!allowed) {
        if (dmPolicy === 'pairing') {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: 'max',
            id: senderStr,
            accountId: account.accountId,
            meta: { name: senderName },
          });
          if (created) {
            log?.info(`[${account.accountId}] Pairing request from ${senderStr}`);
            try {
              const pairingReply = core.channel.pairing.buildPairingReply({
                channel: 'max',
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

  // Group policy (disabled / allowlist incl. "*" / open)
  let voiceMention: MaxVoiceMention | undefined;
  if (isGroup) {
    const admission = admitMaxGroupChat(account, config, chatId);
    if (!admission.admitted) {
      log?.debug?.(
        `[${account.accountId}] Blocked group message (${admission.reason}, chat=${String(chatId)})`,
      );
      return;
    }
    // Sender allowlist (groups.<id>.allowFrom / groupAllowFrom): messages,
    // button presses and commands alike; attachments are not downloaded.
    const senderAdmission = admitMaxGroupSender(account, chatId, senderId);
    if (!senderAdmission.admitted) {
      log?.debug?.(
        `[${account.accountId}] Blocked group message (${senderAdmission.reason}, chat=${String(chatId)}, sender=${String(senderId)})`,
      );
      return;
    }

    // Require mention in groups
    const groupCfg = account.config.groups?.[String(chatId)] ?? account.config.groups?.['*'];
    const requireMention = groupCfg?.requireMention ?? true;
    if (requireMention && !wasMentioned) {
      // A captionless voice message may still name the bot (mention patterns
      // matched against its transcript).
      voiceMention =
        mentionRegexes.length > 0 && !rawText.trim() && groupCfg?.disableAudioPreflight !== true
          ? await resolveMaxVoiceMention({
              attachments,
              messageId,
              chatId,
              chatIdStr,
              senderId: String(senderId),
              mentionRegexes,
              cfg: config,
              api: opts.api,
              account,
              log,
            })
          : undefined;
      if (!voiceMention) {
        log?.debug?.(`[${account.accountId}] Skipping group message (not mentioned)`);
        return;
      }
      wasMentioned = true;
    }
  }

  // Process attachments: download media, build descriptions for non-downloadable types
  // (a voice mention check may have done it already).
  const {
    descriptions: attachmentDescriptions,
    mediaInputs: ownMediaInputs,
    mediaTaken: ownMediaTaken,
  } = voiceMention?.attachments ??
  (await collectInboundAttachments({
    attachments,
    messageId,
    chatId,
    api: opts.api,
    account,
    log,
  }));
  if (voiceMention?.transcript) {
    // Core's transcript echo, deferred until the message passed the gate.
    echoMaxVoiceTranscript({
      cfg: config,
      accountId: account.accountId,
      chatId: chatIdStr,
      transcript: voiceMention.transcript,
    }).catch((err: unknown) => {
      log?.debug?.(`[${account.accountId}] Voice transcript echo failed: ${String(err)}`);
    });
  }
  // Forwarded attachments pass the same gates and download limits as the
  // sender's own (one media count budget per message); their descriptions
  // stay inside the forwarded block.
  const forwarded = forward
    ? await collectInboundAttachments({
        attachments: forward.attachments,
        messageId,
        chatId,
        api: opts.api,
        account,
        log,
        mediaBudget: Math.max(0, resolveInboundMediaMaxCount(account) - ownMediaTaken),
      })
    : undefined;
  const mediaInputs = [...ownMediaInputs, ...(forwarded?.mediaInputs ?? [])];
  const forwardBlock =
    forward && forwarded
      ? formatForwardBlock(forward, forwarded.descriptions, forwarded.mediaInputs.length > 0)
      : '';

  const attachmentText = attachmentDescriptions.join(' ');
  const hasMedia = mediaInputs.length > 0;
  const effectiveText = rawText.trim() || attachmentText || forwardBlock;

  // Nothing usable came out of the attachments (e.g. a failed sticker download)
  if (!effectiveText && !hasMedia) return;

  // Build context
  const fromLabel = isGroup ? `chat:${chatIdStr}` : senderName || `user:${senderId}`;

  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // Combine text and attachment descriptions for the agent; a forward follows
  // the sender's own text as a marked block.
  const ownBodyForAgent = attachmentText
    ? rawText.trim()
      ? `${rawText.trim()}\n${attachmentText}`
      : attachmentText
    : rawText;
  const bodyForAgent = forwardBlock
    ? ownBodyForAgent.trim()
      ? `${ownBodyForAgent.trim()}\n\n${forwardBlock}`
      : forwardBlock
    : ownBodyForAgent;

  const body = core.channel.reply.formatAgentEnvelope({
    channel: 'MAX',
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: bodyForAgent,
  });

  // Detect text-slash commands (user types /status, /models, /reasoning etc.)
  const rawTextTrimmed = (rawText || '').trim();
  const isTextSlashCommand = rawTextTrimmed.startsWith('/');

  // groups.<id> (else "*"): systemPrompt joins the group turn's system prompt,
  // skills limits the skills the turn loads (core GroupSystemPrompt / skillFilter).
  const groupEntry = isGroup
    ? (account.config.groups?.[chatIdStr] ?? account.config.groups?.['*'])
    : undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: bodyForAgent,
    RawBody: rawText,
    // Forwarded text is someone else's words: never parse it as a command or
    // an inline directive, only the sender's own text.
    CommandBody: rawText || (forward ? '' : attachmentText),
    From: `max:${senderId}`,
    To: `max:${chatIdStr}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? 'group' : 'direct',
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId != null ? String(senderId) : undefined,
    SenderUsername: senderUsername,
    WasMentioned: isGroup ? wasMentioned : undefined,
    GroupSystemPrompt: groupEntry?.systemPrompt?.trim() || undefined,
    Provider: 'max',
    Surface: 'max',
    MessageSid: messageId,
    MessageSidFull: messageId,
    ReplyToId: replyToId,
    ReplyToIdFull: replyToId,
    SupplementalContext: buildSupplementalContext(reply, replyToId, forward),
    OriginatingChannel: 'max',
    OriginatingTo: `max:${chatIdStr}`,
    // Media attachments (downloaded to local paths) as ordered media facts
    media: hasMedia ? toInboundMediaFacts(mediaInputs) : undefined,
    // Text-slash command detection: treat /status, /models etc. as text commands
    // so OpenClaw routes them through handleCommands instead of silently dropping
    ...(isTextSlashCommand
      ? {
          CommandSource: 'text' as const,
          CommandTurn: {
            kind: 'text-slash' as const,
            source: 'text' as const,
            authorized: undefined, // let allowFrom resolve authorization
            body: rawTextTrimmed,
          },
        }
      : {}),
  });

  const replyMid =
    isCallbackCommand || !messageBody ? undefined : messageId.replace(/_edited_\d+$/, '');
  const callbackId = isCallbackCommand ? messageId : undefined;

  // A bare command with a core argument menu (/think, /fast, …) opens it as
  // buttons. A menu press is answered here when the sender has no command
  // rights or core no longer offers the choice; otherwise it goes to core as
  // the typed command would.
  if (isTextSlashCommand) {
    const menu = resolveMaxCommandMenu({
      text: rawTextTrimmed,
      press: isCommandMenuPress,
      ctx: ctxPayload,
      cfg: config,
      agentId: route.agentId,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      botUsername: opts.botUsername,
    });
    if (menu.kind === 'menu') {
      await deliverMaxReply({
        payload: { text: menu.text, channelData: { max: { buttons: menu.buttons } } },
        account,
        chatId: chatIdStr,
        replyToId: replyMid,
        callbackId,
        config,
        log,
        statusSink,
      });
      return;
    }
    if (menu.kind !== 'dispatch') {
      if (callbackId) {
        const notification =
          menu.kind === 'denied'
            ? 'You are not allowed to use this command.'
            : 'This menu is out of date. Send the command again.';
        await opts.api.answerCallback(callbackId, { notification }).catch((err: unknown) => {
          log?.debug?.(`[${account.accountId}] MAX callback answer failed: ${String(err)}`);
        });
      }
      log?.debug?.(`[${account.accountId}] Command menu press refused (${menu.kind})`);
      return;
    }
  }

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
    channel: 'max',
    accountId: route.accountId,
  });

  // Typing indicator for the whole turn: core starts it per typingMode and
  // stops the keepalive when the run completes, fails or is aborted.
  const typingCallbacks =
    chatId != null
      ? createMaxTypingCallbacks({
          api: opts.api,
          chatId,
          onError: (err) => {
            log?.debug?.(`[${account.accountId}] typing_on failed: ${String(err)}`);
          },
        })
      : undefined;

  // Streaming modes: "partial" = edit single message, "block" = each block as
  // separate message, "progress" = one turn-status message (progress-draft.ts).
  // Core's streaming.mode wins over the older streamMode; default off.
  const streamMode = resolveChannelPreviewStreamMode(
    account.config as Parameters<typeof resolveChannelPreviewStreamMode>[0],
    account.config.streamMode ?? 'off',
  );
  const useEditStreaming = streamMode === 'partial';
  const useBlockStreaming = streamMode === 'block';

  // Local reply media is read only under the agent's scoped media roots: core
  // persists reply files into its media store, and the agent's own workspace
  // is covered too.
  const replyLocalMedia = {
    mediaLocalRoots: getAgentScopedMediaLocalRoots(config, route.agentId),
  };

  // Draft stream for edit-streaming (like Telegram's partial reply approach)
  const draft = createMaxDraftStream({
    account,
    chatId: chatIdStr,
    replyToId: replyMid,
    log,
    statusSink,
  });

  // Turn status: one message edited while the agent works, deleted once the
  // final answer landed; its failures never fail the turn.
  const progress =
    streamMode === 'progress'
      ? createMaxProgressDraft({ account, chatId: chatIdStr, replyToId: replyMid, log, statusSink })
      : undefined;

  // One press, one answer: later payloads of the turn go to the chat.
  const callbackState = { answered: false };
  let dispatchFailed = false;
  try {
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: config,
      dispatcherOptions: {
        ...prefixOptions,
        typingCallbacks,
        deliver: async (rawPayload, info) => {
          // This funnel consumes ReplyPayload directly, so it must apply the same
          // presentation fallback/render policy as core's outbound path.
          const payload = await materializeMaxPresentation(rawPayload);
          // With a live stream draft the first text chunk replaces it; longer
          // answers continue as new messages, the keyboard on the last chunk.
          const send = () =>
            deliverMaxReply({
              payload,
              account,
              chatId: chatIdStr,
              replyToId: replyMid,
              callbackId,
              callbackState,
              config,
              log,
              statusSink,
              // Tool/block payloads mid-turn go as their own messages; the
              // draft keeps streaming until the final answer replaces it.
              draft: useEditStreaming && info.kind === 'final' ? draft : undefined,
              localMedia: replyLocalMedia,
            });
          if (progress && info.kind === 'final') {
            await progress.deliverFinal({ isError: payload.isError === true, send });
          } else {
            await send();
          }
        },
        onError: (err, info) => {
          log?.error(`[${account.accountId}] MAX ${info.kind} reply failed: ${String(err)}`);
        },
      },
      replyOptions: {
        onModelSelected,
        ...(useEditStreaming
          ? {
              onPartialReply: (payload: { text?: string }) => {
                if (payload.text) draft.update(payload.text);
              },
            }
          : {}),
        ...(useBlockStreaming ? { disableBlockStreaming: false } : {}),
        ...(groupEntry?.skills ? { skillFilter: groupEntry.skills } : {}),
        ...(progress ? progress.replyOptions : {}),
        ...maxTurnAdoptionReplyOptions(),
      },
    });
  } catch (err) {
    dispatchFailed = true;
    throw err;
  } finally {
    await progress?.close({ failed: dispatchFailed });
    await draft.clear();
  }
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
  const username = botUsername?.replace(/^@/, '').toLowerCase();
  return markup.some((element) => {
    if (element?.type !== 'user_mention') return false;
    if (botUserId != null && element.user_id === botUserId) return true;
    const link =
      typeof element.user_link === 'string'
        ? element.user_link.replace(/^@/, '').toLowerCase()
        : '';
    return Boolean(username && link === username);
  });
}

interface MaxForwardedContent {
  text: string;
  attachments: MaxAttachment[];
  /** Original author; null/undefined for channel posts or hidden senders. */
  sender?: MaxUser | null;
  /** Chat where the message was originally posted. */
  chatId?: number;
}

/** Content of a forwarded message (link.type 'forward'), if any. */
function readForwardedMessage(
  link: MaxLinkedMessage | null | undefined,
): MaxForwardedContent | undefined {
  if (link?.type !== 'forward' || !link.message) return undefined;
  return {
    text: link.message.text ?? '',
    attachments: link.message.attachments ?? [],
    sender: link.sender,
    chatId: link.chat_id,
  };
}

function hasAgentAttachments(attachments: MaxAttachment[]): boolean {
  return attachments.some((att) => att.type !== 'inline_keyboard');
}

/** Author label of a linked message: sender name, or the origin chat for channel posts. */
function formatLinkedAuthor(
  sender: MaxUser | null | undefined,
  chatId: number | undefined,
): string | undefined {
  if (sender) return formatSenderName(sender);
  return chatId != null ? `chat:${chatId}` : undefined;
}

/**
 * The forwarded message as a marked block for the agent: header with the
 * author, then its text and attachment descriptions. Empty when nothing
 * usable is left (no text, descriptions or downloaded media).
 */
function formatForwardBlock(
  forward: MaxForwardedContent,
  descriptions: string[],
  hasMedia: boolean,
): string {
  const text = forward.text.trim();
  const attachmentText = descriptions.join(' ');
  if (!text && !attachmentText && !hasMedia) return '';
  const author = formatLinkedAuthor(forward.sender, forward.chatId);
  const header = author ? `[Forwarded message from ${author}]` : '[Forwarded message]';
  return [header, text, attachmentText].filter(Boolean).join('\n');
}

/**
 * Reply quote and forward origin as SDK supplemental facts; core renders
 * them as untrusted "Reply target" / "Forwarded message context" blocks.
 * @internal exported for testing.
 */
export function buildSupplementalContext(
  reply: MaxLinkedMessage | undefined,
  replyToId: string | undefined,
  forward: MaxForwardedContent | undefined,
): { quote?: Record<string, string>; forwarded?: Record<string, string> } | undefined {
  const quote = reply ? buildReplyQuote(reply, replyToId) : undefined;
  const from = forward ? formatLinkedAuthor(forward.sender, forward.chatId) : undefined;
  const forwarded =
    forward && from
      ? {
          from,
          fromType: forward.sender ? 'user' : 'channel',
          ...(forward.sender
            ? { fromId: String(forward.sender.user_id) }
            : forward.chatId != null
              ? { fromId: String(forward.chatId) }
              : {}),
        }
      : undefined;
  if (!quote && !forwarded) return undefined;
  return { ...(quote ? { quote } : {}), ...(forwarded ? { forwarded } : {}) };
}

/** Bounded quote of the replied-to message: its text, else its attachment types. */
function buildReplyQuote(
  reply: MaxLinkedMessage,
  replyToId: string | undefined,
): Record<string, string> | undefined {
  const text = (reply.message?.text ?? '').trim();
  const attachmentTypes = (reply.message?.attachments ?? [])
    .filter((att) => att.type !== 'inline_keyboard')
    .map((att) => `[${att.type ?? 'attachment'}]`)
    .join(' ');
  // Clip by code points so an emoji is never cut in half.
  const quoted = Array.from(text || attachmentTypes);
  const body =
    quoted.length > MAX_REPLY_QUOTE_CHARS
      ? `${quoted.slice(0, MAX_REPLY_QUOTE_CHARS - 1).join('')}…`
      : quoted.join('');
  const sender = formatLinkedAuthor(reply.sender, reply.chat_id);
  if (!body && !sender && !replyToId) return undefined;
  return {
    ...(replyToId ? { id: replyToId, fullId: replyToId } : {}),
    ...(body ? { body } : {}),
    ...(sender ? { sender } : {}),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatSenderName(user?: MaxUser | null): string {
  if (!user) return 'Unknown';
  const parts = [user.first_name];
  if (user.last_name) parts.push(user.last_name);
  return parts.join(' ') || user.username || `user_${user.user_id}`;
}
