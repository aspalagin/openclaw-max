/**
 * Reply delivery for the inbound pipeline: callback answers, markdown chunks
 * with the keyboard on the last one, media albums and delivery.pin.
 */

import type { ChannelLogSink } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import type { ResolvedMaxAccount } from "./accounts.js";
import { readMaxDeliveryPin } from "./presentation.js";
import { getMaxRuntime } from "./runtime.js";
import { answerMaxCallback, pinMaxMessage, readMaxChannelButtons, readMaxChannelSendOptions, sendMaxMediaGroup, sendMaxMessage } from "./send.js";

export async function deliverMaxReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string; replyToId?: string; channelData?: unknown; delivery?: unknown };
  account: ResolvedMaxAccount;
  chatId: string;
  replyToId?: string;
  callbackId?: string;
  config: OpenClawConfig;
  log?: ChannelLogSink;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, account, chatId, config, log, statusSink } = params;
  const core = getMaxRuntime();
  const buttons = readMaxChannelButtons(payload.channelData);
  const sendOptions = readMaxChannelSendOptions(payload.channelData);

  if (params.callbackId && (payload.text || buttons?.length)) {
    try {
      await answerMaxCallback(params.callbackId, payload.text ?? "", {
        token: account.token,
        format: "markdown",
        buttons,
      });
      statusSink?.({ lastOutboundAt: Date.now() });
    } catch (err: unknown) {
      const body = (err as { body?: unknown })?.body;
      log?.error(`[${account.accountId}] MAX callback answer failed: ${String(err)}${body ? ` body=${JSON.stringify(body)}` : ""}`);
    }
    return;
  }

  // delivery.pin: pin the first delivered message (first chunk).
  let firstMessageId: string | undefined;
  const noteDelivered = (messageId: string) => {
    if (!firstMessageId && messageId) firstMessageId = messageId;
  };

  if (payload.text) {
    const chunkLimit = 4000; // MAX message limit
    const chunkMode = core.channel.text.resolveChunkMode(config, "max", account.accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(payload.text, chunkLimit, chunkMode);

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      try {
        const sent = await sendMaxMessage(chatId, chunk, {
          token: account.token,
          replyToMessageId: params.replyToId,
          format: "markdown",
          buttons: index === chunks.length - 1 ? buttons : undefined,
          ...sendOptions,
        });
        noteDelivered(sent.messageId);
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err: unknown) {
        const body = (err as { body?: unknown })?.body;
        log?.error(`[${account.accountId}] MAX send failed: ${String(err)}${body ? ` body=${JSON.stringify(body)}` : ""}`);
      }
    }
  } else if (buttons?.length) {
    try {
      const sent = await sendMaxMessage(chatId, "", {
        token: account.token,
        replyToMessageId: params.replyToId,
        format: "markdown",
        buttons,
        ...sendOptions,
      });
      noteDelivered(sent.messageId);
      statusSink?.({ lastOutboundAt: Date.now() });
    } catch (err: unknown) {
      const body = (err as { body?: unknown })?.body;
      log?.error(`[${account.accountId}] MAX send failed: ${String(err)}${body ? ` body=${JSON.stringify(body)}` : ""}`);
    }
  }

  // Media URLs — upload and send
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  // Images/videos go as albums (up to 12 per message); https image links are
  // sent by URL, other remote media is downloaded and uploaded.
  if (mediaList.length) {
    const sent = await sendMaxMediaGroup(chatId, "", mediaList, {
      token: account.token,
      replyToMessageId: params.replyToId,
      mediaMaxBytes: (account.config.mediaMaxMb ?? 20) * 1024 * 1024,
      ...sendOptions,
      onError: (err, failed) => log?.error(`[${account.accountId}] MAX media send failed (${failed.length} item(s)): ${String(err)}`),
    });
    for (const id of sent.messageIds) noteDelivered(id);
    if (sent.messageIds.length) statusSink?.({ lastOutboundAt: Date.now() });
  }

  const pin = readMaxDeliveryPin(payload.delivery);
  if (pin && firstMessageId) {
    try {
      await pinMaxMessage(chatId, firstMessageId, { token: account.token, pinNotify: pin.notify === true });
    } catch (err) {
      // Optional pins degrade; the delivered message stays.
      log?.[pin.required ? "error" : "warn"](`[${account.accountId}] MAX pin of ${firstMessageId} failed: ${String(err)}`);
    }
  }
}

/** channelData with `max.buttons` removed (other max options kept). */
export function withoutMaxButtons(channelData: unknown): unknown {
  if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) return channelData;
  const maxData = (channelData as Record<string, unknown>).max;
  if (!maxData || typeof maxData !== "object" || Array.isArray(maxData)) return channelData;
  const rest = { ...(maxData as Record<string, unknown>) };
  delete rest.buttons;
  return { ...(channelData as Record<string, unknown>), max: rest };
}
