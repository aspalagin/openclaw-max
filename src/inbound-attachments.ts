/**
 * Inbound attachments: downloads media (image, sticker, video, audio, file)
 * into the gateway media store and describes the rest as text for the agent.
 */

import type { ChannelLogSink } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelInboundMediaInput } from "openclaw/plugin-sdk/channel-inbound";

import type { ResolvedMaxAccount } from "./accounts.js";
import type { MaxApi, MaxAttachment } from "./api.js";
import { sanitizeMaxFileName } from "./media-temp.js";
import { getMaxRuntime } from "./runtime.js";
import { rememberStickerCode } from "./sticker-cache.js";

export interface MaxInboundAttachments {
  /** Text descriptions ([Sticker: …], [Location: …], [Voice transcript: …], failed downloads). */
  descriptions: string[];
  /** One entry per downloaded attachment; array position is attachment identity. */
  mediaInputs: ChannelInboundMediaInput[];
}

/** Process attachments: download media, build descriptions for non-downloadable types. */
export async function collectInboundAttachments(params: {
  attachments: MaxAttachment[];
  messageId: string;
  chatId: number | undefined;
  api: MaxApi;
  account: ResolvedMaxAccount;
  log?: ChannelLogSink;
}): Promise<MaxInboundAttachments> {
  const { attachments, messageId, chatId, api, account, log } = params;
  const core = getMaxRuntime();
  const attachmentDescriptions: string[] = [];
  const mediaInputs: ChannelInboundMediaInput[] = [];

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

      let url = (payload?.url ?? (att as Record<string, unknown>).url ?? "") as string;

      // Inbound video attachments often carry only a token — resolve playback
      // URLs via GET /videos/{videoToken} instead of degrading to "[video]".
      if (!url && attType === "video" && typeof payload?.token === "string" && payload.token) {
        try {
          const info = await api.getVideoInfo(payload.token);
          const urls = info?.urls ?? undefined;
          url = urls?.mp4_720 ?? urls?.mp4_480 ?? urls?.mp4_1080 ?? urls?.mp4_360 ?? urls?.mp4_240 ?? urls?.mp4_144 ?? "";
          if (!url) {
            log?.debug?.(`[${account.accountId}] Video ${payload.token.slice(0, 12)}… has no playback URLs yet`);
          }
        } catch (err) {
          log?.debug?.(`[${account.accountId}] getVideoInfo failed: ${String(err)}`);
        }
      }

      // MAX may transcribe voice messages itself (AudioAttachment.transcription,
      // a sibling of payload). The text goes to the agent and the audio fact is
      // marked transcribed, so core media understanding does not run STT again.
      const transcription = attType === "audio" ? readAudioTranscription(att) : undefined;
      if (transcription) {
        attachmentDescriptions.push(`[Voice transcript: ${transcription}]`);
      }

      if (url && typeof url === "string" && url.startsWith("http")) {
        try {
          const maxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
          const fetched = await core.channel.media.fetchRemoteMedia({ url, maxBytes });
          const inboundFileName = fetched.fileName ? sanitizeMaxFileName(fetched.fileName, fetched.contentType) : undefined;
          const saved = await core.channel.media.saveMediaBuffer(
            Buffer.from(fetched.buffer),
            fetched.contentType,
            "inbound",
            maxBytes,
            inboundFileName,
          );
          // Only the local copy goes to the agent: MAX download URLs are signed
          // and short-lived, so they are not recorded as the media url.
          mediaInputs.push({
            path: saved.path,
            contentType: saved.contentType,
            fileName: inboundFileName,
            messageId,
            ...(transcription ? { transcribed: true } : {}),
          });
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

  return { descriptions: attachmentDescriptions, mediaInputs };
}

/** Non-empty MAX transcription of an audio attachment, if any. */
function readAudioTranscription(att: MaxAttachment): string | undefined {
  const value = att.transcription;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
