/**
 * Reply delivery for the inbound pipeline: callback answers, markdown chunks
 * with the keyboard on the last one (the first chunk may fill the stream
 * draft), media albums and delivery.pin. Failures are rejected per the SDK
 * delivery contract instead of being swallowed.
 */

import type { ChannelLogSink } from 'openclaw/plugin-sdk/channel-contract';
import { createChannelPartialDeliveryError } from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { PlatformMessageNotDispatchedError } from 'openclaw/plugin-sdk/error-runtime';
import { LocalMediaAccessError } from 'openclaw/plugin-sdk/web-media';

import type { ResolvedMaxAccount } from './accounts.js';
import { MaxApiError } from './api.js';
import { readMaxDeliveryPin } from './presentation.js';
import { getMaxRuntime } from './runtime.js';
import {
  answerMaxCallback,
  type MaxLocalMediaAccess,
  pinMaxMessage,
  readMaxChannelButtons,
  readMaxChannelSendOptions,
  sendMaxMediaGroup,
  sendMaxMessage,
} from './send.js';
import type { MaxDraftStream } from './stream-draft.js';

/** What already reached the chat when a later send failed. */
interface MaxVisibleDelivery {
  messageIds: string[];
  /** Text chunks the recipient can see, in order. */
  texts: string[];
}

/**
 * Delivery failure per the SDK contract: once anything became visible (a
 * chunk, an album, the stream draft) the error keeps that subset
 * (createChannelPartialDeliveryError); a send MAX refused outright (4xx)
 * proves nothing was dispatched (PlatformMessageNotDispatchedError, retryable
 * only for 429), as does a local file refused by the media access policy;
 * anything else (5xx, timeout, network) may have been applied and is
 * rethrown as is.
 * @internal exported for testing.
 */
export function toMaxDeliveryError(err: unknown, visible: MaxVisibleDelivery): unknown {
  if (visible.messageIds.length > 0) {
    const content = visible.texts.join('\n\n');
    return createChannelPartialDeliveryError(err, {
      visibleReplySent: true,
      messageIds: [...visible.messageIds],
      ...(content ? { content } : {}),
    });
  }
  if (err instanceof MaxApiError && err.status >= 400 && err.status < 500) {
    return new PlatformMessageNotDispatchedError(err.message, {
      cause: err,
      retryable: err.status === 429,
    });
  }
  if (err instanceof LocalMediaAccessError) {
    return new PlatformMessageNotDispatchedError(err.message, { cause: err, retryable: false });
  }
  return err;
}

function logSendFailure(
  account: ResolvedMaxAccount,
  log: ChannelLogSink | undefined,
  what: string,
  err: unknown,
): void {
  const body = (err as { body?: unknown })?.body;
  log?.error(
    `[${account.accountId}] MAX ${what} failed: ${String(err)}${body ? ` body=${JSON.stringify(body)}` : ''}`,
  );
}

export async function deliverMaxReply(params: {
  payload: {
    text?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
    replyToId?: string;
    channelData?: unknown;
    delivery?: unknown;
  };
  account: ResolvedMaxAccount;
  chatId: string;
  replyToId?: string;
  callbackId?: string;
  config: OpenClawConfig;
  log?: ChannelLogSink;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  /** Edit-streaming draft: the first text chunk replaces it instead of a new message. */
  draft?: MaxDraftStream;
  /** Allowed roots for local reply media (the agent's scoped media roots). */
  localMedia?: MaxLocalMediaAccess;
}): Promise<void> {
  const { payload, account, chatId, config, log, statusSink } = params;
  const core = getMaxRuntime();
  const buttons = readMaxChannelButtons(payload.channelData);
  const sendOptions = readMaxChannelSendOptions(payload.channelData);
  const draftMid = payload.text ? (params.draft?.messageId ?? undefined) : undefined;

  if (params.callbackId && !draftMid && (payload.text || buttons?.length)) {
    try {
      await answerMaxCallback(params.callbackId, payload.text ?? '', {
        token: account.token,
        format: 'markdown',
        buttons,
      });
      statusSink?.({ lastOutboundAt: Date.now() });
    } catch (err: unknown) {
      logSendFailure(account, log, 'callback answer', err);
      throw toMaxDeliveryError(err, { messageIds: [], texts: [] });
    }
    return;
  }

  // Everything the recipient can already see; a visible stream draft counts
  // until it is replaced or deleted.
  const visible: MaxVisibleDelivery = { messageIds: draftMid ? [draftMid] : [], texts: [] };
  let failure: { err: unknown } | undefined;

  // delivery.pin: pin the first delivered message (first chunk).
  let firstMessageId: string | undefined;
  let firstChatType: string | undefined;
  const noteDelivered = (messageId: string, chatType?: string, text?: string) => {
    if (messageId && !visible.messageIds.includes(messageId)) visible.messageIds.push(messageId);
    if (text) visible.texts.push(text);
    if (!firstMessageId && messageId) {
      firstMessageId = messageId;
      firstChatType = chatType;
    }
  };
  const sendTextMessage = async (text: string, messageButtons: typeof buttons) => {
    const sent = await sendMaxMessage(chatId, text, {
      token: account.token,
      replyToMessageId: params.replyToId,
      format: 'markdown',
      buttons: messageButtons,
      ...sendOptions,
    });
    noteDelivered(sent.messageId, sent.raw.message?.recipient?.chat_type, text);
    statusSink?.({ lastOutboundAt: Date.now() });
  };

  if (payload.text) {
    const chunkLimit = 4000; // MAX message limit
    const chunkMode = core.channel.text.resolveChunkMode(config, 'max', account.accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(payload.text, chunkLimit, chunkMode);

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const chunkButtons = index === chunks.length - 1 ? buttons : undefined;
      if (index === 0 && draftMid && params.draft) {
        // The draft becomes the first chunk. If MAX refuses that edit, the
        // stale partial draft is deleted and the answer goes as new messages.
        if (await params.draft.finalize(chunk, chunkButtons)) {
          noteDelivered(draftMid, undefined, chunk);
          continue;
        }
        if (await params.draft.discard()) {
          visible.messageIds.splice(visible.messageIds.indexOf(draftMid), 1);
        }
      }
      try {
        await sendTextMessage(chunk, chunkButtons);
      } catch (err: unknown) {
        // A later chunk after a gap would garble the answer: stop the text,
        // still send the media (independent content), then reject.
        logSendFailure(account, log, 'send', err);
        failure = { err };
        break;
      }
    }
  } else if (buttons?.length) {
    try {
      await sendTextMessage('', buttons);
    } catch (err: unknown) {
      logSendFailure(account, log, 'send', err);
      failure = { err };
    }
  }

  // Media URLs — upload and send
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  // Images/videos go as albums (up to 12 per message); public https image
  // links are sent by URL, other remote media is downloaded (SSRF-guarded)
  // and uploaded, local files are read only under the agent's media roots.
  if (mediaList.length) {
    const sent = await sendMaxMediaGroup(chatId, '', mediaList, {
      token: account.token,
      replyToMessageId: params.replyToId,
      mediaMaxBytes: (account.config.mediaMaxMb ?? 20) * 1024 * 1024,
      localMedia: params.localMedia,
      ...sendOptions,
      onError: (err, failed) => {
        log?.error(
          `[${account.accountId}] MAX media send failed (${failed.length} item(s)): ${String(err)}`,
        );
        failure ??= { err };
      },
    });
    for (const id of sent.messageIds) noteDelivered(id);
    if (sent.messageIds.length) statusSink?.({ lastOutboundAt: Date.now() });
  }

  const pin = readMaxDeliveryPin(payload.delivery);
  if (pin && firstMessageId) {
    try {
      const pinned = await pinMaxMessage(chatId, firstMessageId, {
        token: account.token,
        pinNotify: pin.notify === true,
        chatType: firstChatType,
      });
      if (!pinned.pinned) {
        log?.debug?.(
          `[${account.accountId}] MAX pin of ${firstMessageId} skipped: ${pinned.reason}`,
        );
      }
    } catch (err) {
      // Optional pins degrade; the delivered message stays.
      log?.[pin.required ? 'error' : 'warn'](
        `[${account.accountId}] MAX pin of ${firstMessageId} failed: ${String(err)}`,
      );
    }
  }

  if (failure) throw toMaxDeliveryError(failure.err, visible);
}
