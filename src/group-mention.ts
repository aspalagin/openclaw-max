/**
 * Group mention facts beyond the bot's native mention: core's configured
 * mention patterns (messages.groupChat / agent groupChat mentionPatterns),
 * also matched against the transcript of a captionless voice message — MAX's
 * own transcript, else a core preflight transcription.
 */

import { resolveAgentConfig } from 'openclaw/plugin-sdk/agent-scope-runtime';
import type { ChannelLogSink } from 'openclaw/plugin-sdk/channel-contract';
import {
  buildMentionRegexes,
  type ChannelInboundMediaInput,
  matchesMentionPatterns,
  toInboundMediaFacts,
} from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import {
  createChannelPreflightAudio,
  formatAudioTranscriptForAgent,
} from 'openclaw/plugin-sdk/media-understanding-runtime';

import type { ResolvedMaxAccount } from './accounts.js';
import type { MaxApi, MaxAttachment } from './api.js';
import {
  collectInboundAttachments,
  type MaxInboundAttachments,
  readAudioTranscription,
} from './inbound-attachments.js';

type PreflightRequest = Parameters<
  ReturnType<typeof createChannelPreflightAudio>['resolve']
>[0]['request'];

const maxPreflightAudio = createChannelPreflightAudio<ChannelInboundMediaInput>({
  channel: 'max',
  isAudio: (media) => media.kind === 'audio',
});

/**
 * Only explicitly configured patterns count: without them core derives
 * patterns from the agent's identity name and emoji, which would start waking
 * the bot in MAX groups that so far needed a real mention.
 */
function hasConfiguredMentionPatterns(cfg: OpenClawConfig, agentId: string): boolean {
  const agentGroupChat = resolveAgentConfig(cfg, agentId)?.groupChat;
  if (agentGroupChat && Object.hasOwn(agentGroupChat, 'mentionPatterns')) return true;
  const groupChat = cfg.messages?.groupChat;
  return Boolean(groupChat && Object.hasOwn(groupChat, 'mentionPatterns'));
}

/** Core mention regexes for this group, after the channel's mentionPatterns policy. */
export function resolveMaxMentionRegexes(params: {
  cfg: OpenClawConfig;
  agentId: string;
  account: ResolvedMaxAccount;
  chatId: string;
}): RegExp[] {
  const { cfg, agentId, account, chatId } = params;
  if (!hasConfiguredMentionPatterns(cfg, agentId)) return [];
  return buildMentionRegexes(cfg, agentId, {
    provider: 'max',
    conversationId: chatId,
    ...(account.config.mentionPatterns ? { providerPolicy: account.config.mentionPatterns } : {}),
  });
}

/**
 * Whether a sender may have a voice message transcribed before the mention
 * gate: the group's own allowFrom, else the account's groupAllowFrom; no list
 * means every member of the admitted group.
 */
export function isMaxVoicePreflightSender(
  account: ResolvedMaxAccount,
  groupAllowFrom: unknown,
  senderId: string,
): boolean {
  const list = Array.isArray(groupAllowFrom)
    ? groupAllowFrom
    : (account.config.groupAllowFrom ?? []);
  const entries = list.map((entry) => String(entry).trim().replace(/^max:/i, ''));
  return entries.length === 0 || entries.includes('*') || entries.includes(senderId);
}

/**
 * Transcribe the first audio of the message with core media understanding
 * (tools.media.audio). Returns the transcript and the index of the input core
 * transcribed; undefined when there is no audio, STT is off or it fails.
 */
export async function transcribeMaxVoiceForMention(params: {
  cfg: OpenClawConfig;
  accountId: string;
  chatId: string;
  mediaInputs: ChannelInboundMediaInput[];
}): Promise<{ transcript: string; index: number } | undefined> {
  const ctx = {
    Provider: 'max',
    Surface: 'max',
    OriginatingChannel: 'max',
    OriginatingTo: `max:${params.chatId}`,
    AccountId: params.accountId,
    ChatType: 'group',
    media: toInboundMediaFacts(params.mediaInputs),
  } as PreflightRequest['ctx'];
  const transcript = await maxPreflightAudio.resolve({ request: { ctx, cfg: params.cfg } });
  if (!transcript) return undefined;
  // Core marks the fact it transcribed on the request context.
  const media = (ctx.media ?? []) as Array<{ transcribed?: boolean }>;
  const marked = media.findIndex(
    (fact, index) => fact?.transcribed === true && params.mediaInputs[index]?.transcribed !== true,
  );
  const index =
    marked >= 0 ? marked : params.mediaInputs.findIndex((input) => input.kind === 'audio');
  return { transcript, index };
}

export interface MaxVoiceMention {
  /** Attachments already collected for the check, the transcribed audio marked. */
  attachments?: MaxInboundAttachments;
  /** Core preflight transcript (not set when MAX's own transcript matched). */
  transcript?: string;
}

/**
 * Mention check for a captionless voice message in a mention-gated group
 * whose chat already passed the group policy. MAX's own transcript is matched
 * as is; otherwise, for senders the group admits, the audio is downloaded
 * (mediaMaxMb, mediaMaxCount) and transcribed once by core. The transcript
 * then goes to the agent as core formats it, and the audio fact is marked
 * transcribed so the reply pipeline does not transcribe it again. No match,
 * no audio or any failure: undefined ("not mentioned").
 */
export async function resolveMaxVoiceMention(params: {
  attachments: MaxAttachment[];
  messageId: string;
  chatId: number | undefined;
  chatIdStr: string;
  senderId: string;
  groupAllowFrom: unknown;
  mentionRegexes: RegExp[];
  cfg: OpenClawConfig;
  api: MaxApi;
  account: ResolvedMaxAccount;
  log?: ChannelLogSink;
}): Promise<MaxVoiceMention | undefined> {
  const { attachments, mentionRegexes, account, log } = params;
  const audio = attachments.find((att) => att.type === 'audio');
  if (!audio || mentionRegexes.length === 0) return undefined;

  const platformTranscript = readAudioTranscription(audio);
  if (platformTranscript) {
    return matchesMentionPatterns(platformTranscript, mentionRegexes) ? {} : undefined;
  }
  if (!isMaxVoicePreflightSender(account, params.groupAllowFrom, params.senderId)) {
    return undefined;
  }

  try {
    const collected = await collectInboundAttachments({
      attachments,
      messageId: params.messageId,
      chatId: params.chatId,
      api: params.api,
      account,
      log,
    });
    if (!collected.mediaInputs.some((input) => input.kind === 'audio' && !input.transcribed)) {
      return undefined;
    }
    const result = await transcribeMaxVoiceForMention({
      cfg: params.cfg,
      accountId: account.accountId,
      chatId: params.chatIdStr,
      mediaInputs: collected.mediaInputs,
    });
    if (!result || !matchesMentionPatterns(result.transcript, mentionRegexes)) return undefined;
    const mediaInputs = collected.mediaInputs.map((input, index) =>
      index === result.index ? { ...input, transcribed: true } : input,
    );
    return {
      attachments: {
        ...collected,
        mediaInputs,
        descriptions: [...collected.descriptions, formatAudioTranscriptForAgent(result.transcript)],
      },
      transcript: result.transcript,
    };
  } catch (err) {
    log?.debug?.(`[${account.accountId}] Voice mention check failed: ${String(err)}`);
    return undefined;
  }
}

/** Core's deferred transcript echo (tools.media.audio.echoTranscript), after the gate. */
export async function echoMaxVoiceTranscript(params: {
  cfg: OpenClawConfig;
  accountId: string;
  chatId: string;
  transcript: string;
}): Promise<void> {
  await maxPreflightAudio.send({
    transcript: params.transcript,
    cfg: params.cfg,
    accountId: params.accountId,
    originatingTo: `max:${params.chatId}`,
  });
}
