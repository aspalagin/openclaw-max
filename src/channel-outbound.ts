/**
 * Outbound adapter of the MAX channel: sendText / sendPayload / sendMedia,
 * presentation rendering and delivery pins for core's outbound path.
 */

import { createActionGate } from 'openclaw/plugin-sdk/channel-actions';
import type { ChannelPlugin } from 'openclaw/plugin-sdk/channel-core';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { getAgentScopedMediaLocalRoots } from 'openclaw/plugin-sdk/media-local-roots';

import { type ResolvedMaxAccount, resolveMaxAccount } from './accounts.js';
import { MaxApi } from './api.js';
import { assertCommentFields, assertCommentPost, commentMid, sendTextComment } from './comments.js';
import { resolveMaxTableMode, toMaxMarkdown } from './format.js';
import {
  isMaxPinEnabled,
  materializeMaxPresentation,
  MAX_PIN_DISABLED,
  MAX_PRESENTATION_CAPABILITIES,
  MAX_TEXT_LIMIT,
  renderMaxPresentation,
  resolveMaxTextChunkLimit,
} from './presentation.js';
import { getMaxRuntime, loadMaxConfig } from './runtime.js';
import {
  type MaxLocalMediaAccess,
  pinMaxMessage,
  readMaxChannelButtons,
  resolveMaxSendFlags,
  sendMaxMediaGroup,
  sendMaxMediaMessage,
  sendMaxMessage,
} from './send.js';

type MaxChannelPlugin = ChannelPlugin<ResolvedMaxAccount>;

/** MAX dialect and tables of the account (markdown.tables); see format.ts. */
function formatMaxText(text: string, account: ResolvedMaxAccount): string {
  return toMaxMarkdown(text, { tableMode: resolveMaxTableMode(account.config) });
}

/**
 * Local media access for an outbound send: the roots and host reader core
 * passed with the delivery; without them the default media roots (no agent
 * workspace is known here). Local files are read only through this policy.
 */
function resolveOutboundLocalMedia(
  cfg: OpenClawConfig,
  ctx: MaxLocalMediaAccess,
): MaxLocalMediaAccess {
  if (ctx.mediaAccess || ctx.mediaLocalRoots?.length || ctx.mediaReadFile) {
    return {
      mediaAccess: ctx.mediaAccess,
      mediaLocalRoots: ctx.mediaLocalRoots,
      mediaReadFile: ctx.mediaReadFile,
    };
  }
  return { mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg) };
}

type Outbound = NonNullable<MaxChannelPlugin['outbound']>;
type TextContext = Parameters<NonNullable<Outbound['sendText']>>[0];

async function deliverComment(ctx: TextContext, payload?: Record<string, unknown>) {
  const postId = commentMid(ctx.threadId);
  if (ctx.silent || ctx.mediaUrl || ctx.audioAsVoice || ctx.forceDocument || ctx.gifPlayback) {
    throw new Error('MAX comments support text only, without silent delivery');
  }
  if (payload) assertCommentFields(payload, ['text', 'replyToId']);
  const account = resolveMaxAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
  if (!account.token) throw new Error('MAX bot token not configured');
  if (!createActionGate(account.config.actions)('send'))
    throw new Error('MAX action "send" is disabled by channels.max.actions');
  const api = new MaxApi({ token: account.token });
  await assertCommentPost(api, ctx.to, postId);
  const replyTo =
    ctx.replyToId ?? (payload?.replyToId == null ? undefined : commentMid(payload.replyToId));
  const messageId = await sendTextComment(api, account, postId, ctx.text, replyTo, () => {
    ctx.signal?.throwIfAborted();
    ctx.assertDirectAdapterHandoff?.();
  });
  return { channel: 'max' as const, messageId };
}

/** Direct delivery with markdown chunks of at most 4000 characters. */
export const maxOutboundAdapter: NonNullable<MaxChannelPlugin['outbound']> = {
  deliveryMode: 'direct',
  // Core passes channels.max.textChunkLimit here; MAX rejects anything longer than 4000.
  chunker: (text, limit) =>
    getMaxRuntime().channel.text.chunkMarkdownText(text, Math.min(limit, MAX_TEXT_LIMIT)),
  chunkerMode: 'markdown',
  textChunkLimit: 4000,
  // Before core chunks the text: tables become bullets or one code block, so
  // the chunker measures the text as sent and never splits a raw table.
  normalizePayload: ({ payload, cfg, accountId }) =>
    payload.text
      ? { ...payload, text: formatMaxText(payload.text, resolveMaxAccount({ cfg, accountId })) }
      : payload,

  // Presentation (docs/plugins/message-presentation.md): core adapts to these
  // capabilities, renders through renderPresentation and pins through
  // pinDeliveredMessage after the first delivered message.
  presentationCapabilities: MAX_PRESENTATION_CAPABILITIES,
  deliveryCapabilities: { pin: true },
  renderPresentation: ({ payload, presentation, ctx }) => {
    if (ctx?.threadId != null) throw new Error('MAX comments do not support presentation');
    return renderMaxPresentation(payload, presentation);
  },
  pinDeliveredMessage: async ({ cfg, target, messageId, pin, assertDirectAdapterHandoff }) => {
    if (target.threadId != null) throw new Error('MAX comments do not support pin');
    const account = resolveMaxAccount({ cfg, accountId: target.accountId });
    if (!account.token) throw new Error('MAX bot token not configured');
    // channels.max.actions.pin gates this pin too: core keeps the delivered
    // message and logs the refusal (a required pin fails the delivery).
    if (!isMaxPinEnabled(account.config.actions)) throw new Error(MAX_PIN_DISABLED);
    assertDirectAdapterHandoff?.();
    // Dialogs cannot pin: pinMaxMessage resolves { pinned: false } without an
    // API call or error, so core logs no failed pin for a DM delivery.
    await pinMaxMessage(target.to, messageId, {
      token: account.token,
      pinNotify: pin.notify === true,
      beforeRequest: assertDirectAdapterHandoff,
    });
  },

  sendPayload: async (ctx) => {
    if (ctx.threadId != null) return deliverComment(ctx, ctx.payload);
    const { to, text, payload: rawPayload, mediaUrl, accountId, replyToId } = ctx;
    const cfg = await loadMaxConfig();
    const account = resolveMaxAccount({ cfg, accountId });
    if (!account.token) throw new Error('MAX bot token not configured');

    // Core renders presentation before sendPayload; a payload that still
    // carries one came through a path that did not, so apply the same policy.
    const payload = rawPayload.presentation
      ? await materializeMaxPresentation(rawPayload)
      : rawPayload;
    const effectiveText = formatMaxText(
      payload === rawPayload ? text : (payload.text ?? ''),
      account,
    );
    const buttons = readMaxChannelButtons(payload.channelData);
    const sendFlags = resolveMaxSendFlags(account.config, {
      silent: ctx.silent,
      channelData: payload.channelData,
    });
    const mediaUrls = mediaUrl
      ? [mediaUrl]
      : payload.mediaUrls?.length
        ? payload.mediaUrls
        : payload.mediaUrl
          ? [payload.mediaUrl]
          : [];

    if (mediaUrls.length) {
      // Albums: up to 12 images/videos per message, caption on the first,
      // buttons on the last; report the first message (delivery.pin).
      const result = await sendMaxMediaGroup(to, effectiveText, mediaUrls, {
        token: account.token,
        replyToMessageId: replyToId ?? undefined,
        format: 'markdown',
        buttons,
        ...sendFlags,
        mediaMaxBytes: (account.config.mediaMaxMb ?? 20) * 1024 * 1024,
        localMedia: resolveOutboundLocalMedia(cfg, ctx),
        asVoice: ctx.audioAsVoice === true || payload.audioAsVoice === true,
      });
      return {
        channel: 'max',
        messageId: result.messageIds[0] ?? '',
      };
    }

    // MAX caps a message at 4000 characters: split, keyboard on the last
    // chunk, report the first one (delivery.pin pins the first chunk).
    const chunkLimit = resolveMaxTextChunkLimit(cfg, account.accountId);
    const chunks =
      effectiveText.length > chunkLimit
        ? getMaxRuntime().channel.text.chunkMarkdownText(effectiveText, chunkLimit)
        : [effectiveText];
    let firstMessageId = '';
    for (let index = 0; index < chunks.length; index += 1) {
      const result = await sendMaxMessage(to, chunks[index], {
        token: account.token,
        replyToMessageId: index === 0 ? (replyToId ?? undefined) : undefined,
        format: 'markdown',
        buttons: index === chunks.length - 1 ? buttons : undefined,
        ...sendFlags,
      });
      if (index === 0) firstMessageId = result.messageId;
    }

    return {
      channel: 'max',
      messageId: firstMessageId,
    };
  },

  sendText: async (ctx) => {
    if (ctx.threadId != null) return deliverComment(ctx);
    const { to, text, accountId, replyToId, silent } = ctx;
    const cfg = await loadMaxConfig();
    const account = resolveMaxAccount({ cfg, accountId });
    if (!account.token) throw new Error('MAX bot token not configured');

    const result = await sendMaxMessage(to, formatMaxText(text, account), {
      token: account.token,
      replyToMessageId: replyToId ?? undefined,
      format: 'markdown',
      ...resolveMaxSendFlags(account.config, { silent }),
    });

    return {
      channel: 'max',
      messageId: result.messageId,
    };
  },

  sendMedia: async (ctx) => {
    if (ctx.threadId != null) return deliverComment(ctx);
    const { to, mediaUrl, accountId, replyToId } = ctx;
    const cfg = await loadMaxConfig();
    const account = resolveMaxAccount({ cfg, accountId });
    if (!account.token) throw new Error('MAX bot token not configured');
    const sendFlags = resolveMaxSendFlags(account.config, { silent: ctx.silent });
    const text = formatMaxText(ctx.text, account);

    if (!mediaUrl) {
      // No media, send as text
      const result = await sendMaxMessage(to, text, {
        token: account.token,
        replyToMessageId: replyToId ?? undefined,
        format: 'markdown',
        ...sendFlags,
      });
      return {
        channel: 'max',
        messageId: result.messageId,
      };
    }

    // Upload and send media
    const result = await sendMaxMediaMessage(to, text, mediaUrl, {
      token: account.token,
      replyToMessageId: replyToId ?? undefined,
      format: 'markdown',
      ...sendFlags,
      mediaMaxBytes: (account.config.mediaMaxMb ?? 20) * 1024 * 1024,
      localMedia: resolveOutboundLocalMedia(cfg, ctx),
      asVoice: ctx.audioAsVoice === true,
    });

    return {
      channel: 'max',
      messageId: result.messageId,
    };
  },
};
