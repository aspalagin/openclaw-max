/**
 * Inbound attachments: downloads media (image, sticker, video, audio, file)
 * into the gateway media store and describes the rest as text for the agent.
 */

import type { ChannelLogSink } from 'openclaw/plugin-sdk/channel-contract';
import type { ChannelInboundMediaInput } from 'openclaw/plugin-sdk/channel-inbound';

import { type ResolvedMaxAccount, resolveMaxAccountNetwork } from './accounts.js';
import type { MaxApi, MaxAttachment } from './api.js';
import { fetchMaxRemoteMedia, sanitizeMaxFileName } from './media-temp.js';
import { getMaxRuntime } from './runtime.js';
import { rememberStickerCode } from './sticker-cache.js';

export interface MaxInboundAttachments {
  /** Text descriptions ([Sticker: …], [Location: …], [Voice transcript: …], failed downloads). */
  descriptions: string[];
  /** One entry per downloaded attachment; array position is attachment identity. */
  mediaInputs: ChannelInboundMediaInput[];
  /** Media attachments taken for download (the per-message count limit). */
  mediaTaken: number;
}

/** Default most media attachments downloaded per inbound message: a full MAX album. */
export const DEFAULT_INBOUND_MEDIA_MAX_COUNT = 12;

/** Per-message media count limit of the account (`mediaMaxCount`). */
export function resolveInboundMediaMaxCount(account: ResolvedMaxAccount): number {
  return account.config.mediaMaxCount ?? DEFAULT_INBOUND_MEDIA_MAX_COUNT;
}

/** A voice message whose audio could not be loaded and has no MAX transcript. */
const VOICE_UNAVAILABLE = '[Voice message: audio unavailable, no transcript]';

/** Longest link-preview description handed to the agent. */
const MAX_SHARE_DESCRIPTION_CHARS = 300;

/** Process attachments: download media, build descriptions for non-downloadable types. */
export async function collectInboundAttachments(params: {
  attachments: MaxAttachment[];
  messageId: string;
  chatId: number | undefined;
  api: MaxApi;
  account: ResolvedMaxAccount;
  log?: ChannelLogSink;
  /** Media downloads left for this message; default: the account's mediaMaxCount. */
  mediaBudget?: number;
}): Promise<MaxInboundAttachments> {
  const { attachments, messageId, chatId, api, account, log } = params;
  const core = getMaxRuntime();
  const attachmentDescriptions: string[] = [];
  const mediaInputs: ChannelInboundMediaInput[] = [];
  const mediaBudget = params.mediaBudget ?? resolveInboundMediaMaxCount(account);
  let mediaTaken = 0;
  let mediaSkipped = 0;

  for (const att of attachments) {
    const attType = att.type ?? 'unknown';
    const payload = att.payload as Record<string, unknown> | undefined;

    // Media types with downloadable URL: image, sticker, video, audio, file
    if (['image', 'sticker', 'video', 'audio', 'file'].includes(attType)) {
      // For stickers, always capture the code for outbound use
      const stickerCode = attType === 'sticker' ? ((payload?.code ?? '') as string) : '';
      if (stickerCode) {
        log?.debug?.(`[${account.accountId}] Sticker received: code=${stickerCode}`);
        attachmentDescriptions.push(`[Sticker: code=${stickerCode}]`);
        if (chatId != null) {
          rememberStickerCode(chatId, stickerCode);
        }
      }

      // MAX may transcribe voice messages itself (AudioAttachment.transcription,
      // a sibling of payload). The platform transcript wins: the text goes to
      // the agent and the audio fact is marked transcribed (the SDK contract
      // for platform transcripts), so core media understanding skips STT.
      // Without it the fact stays untranscribed and core STT
      // (tools.media.audio) runs; a failed STT leaves core's marker.
      const transcription = attType === 'audio' ? readAudioTranscription(att) : undefined;
      if (transcription) {
        attachmentDescriptions.push(`[Voice transcript: ${transcription}]`);
      }

      // Over the per-message count limit: no lookup, no download; the text
      // parts above (sticker code, transcript) are cheap and stay.
      if (mediaTaken >= mediaBudget) {
        mediaSkipped += 1;
        continue;
      }
      mediaTaken += 1;

      let url = (payload?.url ?? (att as Record<string, unknown>).url ?? '') as string;

      // Inbound video attachments often carry only a token — resolve playback
      // URLs via GET /videos/{videoToken} instead of degrading to "[video]".
      if (!url && attType === 'video' && typeof payload?.token === 'string' && payload.token) {
        try {
          const info = await api.getVideoInfo(payload.token);
          const urls = info?.urls ?? undefined;
          url =
            urls?.mp4_720 ??
            urls?.mp4_480 ??
            urls?.mp4_1080 ??
            urls?.mp4_360 ??
            urls?.mp4_240 ??
            urls?.mp4_144 ??
            '';
          if (!url) {
            log?.debug?.(
              `[${account.accountId}] Video ${payload.token.slice(0, 12)}… has no playback URLs yet`,
            );
          }
        } catch (err) {
          log?.debug?.(`[${account.accountId}] getVideoInfo failed: ${String(err)}`);
        }
      }

      // Fall back to text description (sticker code already added above);
      // never the signed download URL.
      const describeNotLoaded = (reason: string): void => {
        if (attType === 'audio') {
          if (!transcription) attachmentDescriptions.push(VOICE_UNAVAILABLE);
        } else if (attType !== 'sticker') {
          attachmentDescriptions.push(describeUnloadedMedia(att, attType, reason));
        }
      };
      const maxMb = account.config.mediaMaxMb ?? 20;
      const maxBytes = maxMb * 1024 * 1024;
      const declaredSize = readAttachmentSize(att);
      const downloadable = Boolean(url && typeof url === 'string' && url.startsWith('http'));

      if (downloadable && declaredSize !== undefined && declaredSize > maxBytes) {
        // MAX declares the size of a file: one over the limit is not downloaded.
        log?.warn?.(
          `[${account.accountId}] ${attType} of ${messageId} not loaded: ${declaredSize} bytes, over the mediaMaxMb limit of ${maxMb} MB`,
        );
        describeNotLoaded(`превышает лимит ${maxMb} MB`);
      } else if (downloadable) {
        try {
          const { proxyUrl } = resolveMaxAccountNetwork(account);
          const fetched = await fetchMaxRemoteMedia(url, maxBytes, proxyUrl);
          const inboundFileName = fetched.fileName
            ? sanitizeMaxFileName(fetched.fileName, fetched.contentType)
            : undefined;
          const saved = await core.channel.media.saveMediaBuffer(
            Buffer.from(fetched.buffer),
            fetched.contentType,
            'inbound',
            maxBytes,
            inboundFileName,
          );
          // Only the local copy goes to the agent: MAX download URLs are signed
          // and short-lived, so they are not recorded as the media url.
          // A MAX audio attachment is a voice message: the explicit kind keeps
          // core STT selecting it even when the CDN answers with a generic
          // content type.
          mediaInputs.push({
            path: saved.path,
            contentType: saved.contentType,
            fileName: inboundFileName,
            messageId,
            ...(attType === 'audio' ? { kind: 'audio' as const } : {}),
            ...(transcription ? { transcribed: true } : {}),
          });
        } catch (err) {
          log?.error?.(
            `[${account.accountId}] Failed to download ${attType} of ${messageId}: ${redactUrls(String(err))}`,
          );
          const tooLarge = (err as { code?: unknown } | null)?.code === 'max_bytes';
          describeNotLoaded(tooLarge ? `превышает лимит ${maxMb} MB` : 'ошибка загрузки');
        }
      } else {
        // No URL — text description
        if (attType === 'audio') {
          if (!transcription) attachmentDescriptions.push(VOICE_UNAVAILABLE);
        } else if (attType === 'sticker') {
          const code = payload?.code ?? '';
          attachmentDescriptions.push(`[Sticker${code ? `: ${code}` : ''}]`);
        } else if (attType === 'file') {
          const filename = (att as Record<string, unknown>).filename ?? payload?.filename ?? '';
          attachmentDescriptions.push(`[File${filename ? `: ${filename}` : ''}]`);
        } else {
          attachmentDescriptions.push(`[${attType}]`);
        }
      }
    } else if (attType === 'share') {
      attachmentDescriptions.push(describeShare(att));
    } else if (attType === 'location') {
      attachmentDescriptions.push(describeLocation(att));
    } else if (attType === 'contact') {
      attachmentDescriptions.push(describeContact(payload));
    } else if (attType !== 'inline_keyboard') {
      attachmentDescriptions.push(`[${attType}]`);
    }
  }

  if (mediaSkipped > 0) {
    log?.warn?.(
      `[${account.accountId}] ${mediaSkipped} media attachment(s) of ${messageId} not loaded: mediaMaxCount`,
    );
    attachmentDescriptions.push(
      `[${mediaSkipped} more media attachment(s) not loaded: limit of ${resolveInboundMediaMaxCount(account)} per message]`,
    );
  }

  return { descriptions: attachmentDescriptions, mediaInputs, mediaTaken };
}

/** Size in bytes MAX declares for an attachment (files carry it), if any. */
function readAttachmentSize(att: MaxAttachment): number | undefined {
  const raw = att as Record<string, unknown>;
  const value = raw.size ?? (raw.payload as Record<string, unknown> | undefined)?.size;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * A media attachment that was not loaded, for the agent: type, file name and
 * size when MAX sent them, and why.
 */
function describeUnloadedMedia(att: MaxAttachment, attType: string, reason: string): string {
  const raw = att as Record<string, unknown>;
  const payload = raw.payload as Record<string, unknown> | undefined;
  const size = readAttachmentSize(att);
  const parts = [
    toInlineText(raw.filename ?? payload?.filename),
    size !== undefined ? `${(size / (1024 * 1024)).toFixed(1)} MB` : '',
  ].filter(Boolean);
  return `[${attType}${parts.length ? `: ${parts.join(', ')}` : ''} — не загружен: ${reason}]`;
}

/** Error text for logs: MAX download URLs are signed, so they never reach the log. */
function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+?(?=:?(?:\s|$))/g, '<url>');
}

/** One line of untrusted text: whitespace collapsed, clipped by code points. */
function toInlineText(value: unknown, maxChars?: number): string {
  if (typeof value !== 'string') return '';
  const chars = Array.from(value.replace(/\s+/g, ' ').trim());
  if (maxChars === undefined || chars.length <= maxChars) return chars.join('');
  return `${chars.slice(0, maxChars - 1).join('')}…`;
}

/** Link preview card: title, description and link, whichever MAX sent. */
function describeShare(att: MaxAttachment): string {
  const raw = att as Record<string, unknown>;
  const payload = raw.payload as Record<string, unknown> | undefined;
  const url = toInlineText(payload?.url ?? raw.url);
  const parts = [
    toInlineText(raw.title),
    toInlineText(raw.description, MAX_SHARE_DESCRIPTION_CHARS),
    url,
  ].filter(Boolean);
  return parts.length ? `[Share: ${parts.join(' — ')}]` : '[Share]';
}

/** Coordinates with a map link (a Yandex Maps placemark). */
function describeLocation(att: MaxAttachment): string {
  const raw = att as Record<string, unknown>;
  const payload = raw.payload as Record<string, unknown> | undefined;
  const lat = Number(raw.latitude ?? payload?.latitude);
  const lon = Number(raw.longitude ?? payload?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return '[Location]';
  return `[Location: ${lat}, ${lon} — https://yandex.ru/maps/?pt=${lon},${lat}&z=16&l=map]`;
}

/** Contact card: name and phones from the VCard, the MAX profile if linked; never the raw VCard. */
function describeContact(payload: Record<string, unknown> | undefined): string {
  const vcard = typeof payload?.vcf_info === 'string' ? parseMaxVcard(payload.vcf_info) : undefined;
  const user = payload?.max_info as Record<string, unknown> | null | undefined;
  const profileName = [user?.first_name, user?.last_name]
    .map((part) => toInlineText(part))
    .filter(Boolean)
    .join(' ');
  const name = vcard?.name || profileName || toInlineText(payload?.name);
  const parts = name ? [name] : [];
  if (vcard?.phones.length) parts.push(`phone: ${vcard.phones.join(', ')}`);
  if (user && typeof user.user_id === 'number') {
    const username = toInlineText(user.username);
    parts.push(`MAX user: ${user.user_id}${username ? ` (@${username.replace(/^@/, '')})` : ''}`);
  }
  return parts.length ? `[Contact: ${parts.join('; ')}]` : '[Contact]';
}

/** Most phone numbers taken from one VCard. */
const MAX_VCARD_PHONES = 5;

/**
 * Display name and phone numbers of a VCard (2.1/3.0/4.0): FN, else N; TEL
 * values (a `tel:` URI prefix dropped). Folded lines, escapes and
 * quoted-printable values are decoded; everything else is ignored.
 * @internal exported for testing.
 */
export function parseMaxVcard(vcf: string): { name: string; phones: string[] } {
  const lines = vcf.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  let fullName = '';
  let structuredName = '';
  const phones: string[] = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const [rawProperty, ...params] = line.slice(0, colon).split(';');
    const property = rawProperty.replace(/^[^.]*\./, '').toUpperCase();
    let value = line.slice(colon + 1);
    if (params.some((param) => /^ENCODING=QUOTED-PRINTABLE$/i.test(param))) {
      value = decodeQuotedPrintable(value);
    }
    if (property === 'FN' && !fullName) {
      fullName = toInlineText(unescapeVcardValue(value));
    } else if (property === 'N' && !structuredName) {
      // N: family;given;additional;prefix;suffix
      const [family = '', given = ''] = value.split(';').map(unescapeVcardValue);
      structuredName = toInlineText(`${given} ${family}`);
    } else if (property === 'TEL') {
      const phone = toInlineText(unescapeVcardValue(value).replace(/^tel:/i, ''));
      if (phone && !phones.includes(phone) && phones.length < MAX_VCARD_PHONES) phones.push(phone);
    }
  }
  return { name: fullName || structuredName, phones };
}

function unescapeVcardValue(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, ch: string) => (ch === 'n' || ch === 'N' ? ' ' : ch));
}

function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const hex = value[i] === '=' ? value.slice(i + 1, i + 3) : '';
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(value[i], 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Non-empty MAX transcription of an audio attachment, if any. */
export function readAudioTranscription(att: MaxAttachment): string | undefined {
  const value = att.transcription;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
