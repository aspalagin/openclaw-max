/**
 * MAX channel message actions adapter — implements message tool actions
 */

import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
} from 'openclaw/plugin-sdk/channel-contract';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { normalizeMessagePresentation } from 'openclaw/plugin-sdk/interactive-runtime';
import { getAgentScopedMediaLocalRoots } from 'openclaw/plugin-sdk/media-local-roots';
import { readStringParam } from 'openclaw/plugin-sdk/param-readers';
import { jsonResult } from 'openclaw/plugin-sdk/tool-results';

import { listMaxAccountIds, resolveMaxAccount } from './accounts.js';
import { assertMaxActionInScope } from './action-scope.js';
import { sanitizeMaxFileName } from './media-temp.js';
import { materializeMaxPresentation, MAX_TEXT_LIMIT, readMaxDeliveryPin } from './presentation.js';
import { getMaxRuntime } from './runtime.js';
import {
  deleteMaxMessage,
  describeMaxMediaSource,
  editMaxMessage,
  type MaxLocalMediaAccess,
  type MaxMediaSendOptions,
  type MaxMediaSource,
  pinMaxMessage,
  readMaxChannelButtons,
  readMaxSendButtons,
  resolveMaxSendFlags,
  sendMaxContact,
  sendMaxLocation,
  sendMaxMediaGroup,
  sendMaxMediaMessage,
  sendMaxMessage,
  sendMaxSticker,
  unpinMaxMessage,
} from './send.js';
import { getLastStickerCode } from './sticker-cache.js';

const providerId = 'max';
const mediaSourceKeys = ['media', 'filePath', 'path', 'fileUrl', 'url', 'buffer', 'image'] as const;
/**
 * Params that carry a media path or URL, per action: core normalizes them for
 * the sandbox and scopes outbound media access to them. `buffer` is base64
 * content for core, not a path, so it is not declared.
 */
const mediaSourceParams = mediaSourceKeys.filter((key) => key !== 'buffer');

/** `data:<type>;base64,<data>` — a data URL in `buffer`. */
const DATA_URL_RE = /^data:([^;,]*)(?:;[^,]*)?;base64,/i;

/**
 * Inline content from `buffer` (base64 or a base64 data URL) with `filename`
 * and `contentType` (aliases fileName, mimeType) of the same object. The size
 * limit is checked before decoding, so an oversized payload is refused
 * without allocating it.
 */
function readInlineMedia(
  source: Record<string, unknown>,
  maxBytes: number,
): MaxMediaSource | undefined {
  const raw = typeof source.buffer === 'string' ? source.buffer : undefined;
  if (!raw?.trim()) return undefined;
  const dataUrl = DATA_URL_RE.exec(raw);
  const base64 = (dataUrl ? raw.slice(dataUrl[0].length) : raw).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(base64)) {
    throw new Error('buffer is not valid base64 content');
  }
  const decodedBytes = Math.floor((base64.replace(/=+$/, '').length * 3) / 4);
  if (decodedBytes > maxBytes) {
    throw new Error(
      `buffer is ${decodedBytes} bytes, over the ${maxBytes}-byte media limit (mediaMaxMb)`,
    );
  }
  const buffer = Buffer.from(
    base64,
    base64.includes('-') || base64.includes('_') ? 'base64url' : 'base64',
  );
  if (buffer.byteLength === 0) throw new Error('buffer is empty');
  const pick = (...keys: string[]) =>
    keys
      .map((key) => source[key])
      .find((value): value is string => typeof value === 'string' && value.trim() !== '')
      ?.trim();
  const contentType = pick('contentType', 'mimeType') ?? (dataUrl?.[1] || undefined);
  return {
    buffer,
    fileName: sanitizeMaxFileName(pick('filename', 'fileName'), contentType),
    contentType,
  };
}

/**
 * Local media access for an action: the roots and host reader core passed
 * with the action; without them (direct plugin dispatch) the agent-scoped
 * default roots. Local files are read only through this policy.
 */
function resolveActionLocalMedia(ctx: ChannelMessageActionContext): MaxLocalMediaAccess {
  if (ctx.mediaAccess || ctx.mediaLocalRoots?.length || ctx.mediaReadFile) {
    return {
      mediaAccess: ctx.mediaAccess,
      mediaLocalRoots: ctx.mediaLocalRoots,
      mediaReadFile: ctx.mediaReadFile,
    };
  }
  return { mediaLocalRoots: getAgentScopedMediaLocalRoots(ctx.cfg, ctx.agentId ?? undefined) };
}

function listEnabledAccounts(cfg: OpenClawConfig) {
  return listMaxAccountIds(cfg)
    .map((accountId) => resolveMaxAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.token);
}

function readTargetParam(params: Record<string, unknown>, required = true): string | undefined {
  return (
    readStringParam(params, 'to') ??
    readStringParam(params, 'target') ??
    readStringParam(params, 'chatId') ??
    readStringParam(params, 'channelId', { required })
  );
}

/**
 * Media sources in order: the direct media field first, then every
 * structured `attachments[]` item (one source per item). Duplicates dropped.
 * A path or URL wins over `buffer` (core may fill both; the path goes through
 * the guarded loader); `buffer` alone is sent as inline content.
 */
function readMediaSources(params: Record<string, unknown>, maxBytes: number): MaxMediaSource[] {
  const sources: MaxMediaSource[] = [];
  const add = (value: MaxMediaSource | undefined) => {
    if (value && !sources.includes(value)) sources.push(value);
  };
  const readPath = (source: Record<string, unknown>): string | undefined => {
    for (const key of mediaSourceParams) {
      const value = readStringParam(source, key, { trim: false });
      if (value) return value;
    }
    return undefined;
  };

  add(readPath(params) ?? readInlineMedia(params, maxBytes));

  if (Array.isArray(params.attachments)) {
    for (const item of params.attachments) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const attachment = item as Record<string, unknown>;
      add(readPath(attachment) ?? readInlineMedia(attachment, maxBytes));
    }
  }

  return sources;
}

/**
 * Send one or more media sources: one goes as a single message, several as
 * albums (up to 12 images/videos per message, audio/files one by one, order
 * kept). Returns every sent message id; the first one carries the caption.
 */
async function sendMaxMediaSources(
  to: string,
  caption: string,
  sources: MaxMediaSource[],
  opts: MaxMediaSendOptions,
): Promise<{
  messageId: string;
  messageIds: string[];
  chatType?: string;
  mediaErrors?: string[];
}> {
  if (sources.length === 1) {
    const result = await sendMaxMediaMessage(to, caption, sources[0], opts);
    return {
      messageId: result.messageId,
      messageIds: result.messageId ? [result.messageId] : [],
      chatType: result.raw.message?.recipient?.chat_type,
    };
  }
  // A failed group must not hide the ones already sent (a retry by the agent
  // would duplicate them): report partial failures, throw only when none went.
  const errors: string[] = [];
  let firstError: unknown;
  const { messageIds } = await sendMaxMediaGroup(to, caption, sources, {
    ...opts,
    onError: (err, failed) => {
      firstError ??= err;
      errors.push(`${failed.map(describeMaxMediaSource).join(', ')}: ${String(err)}`);
    },
  });
  if (messageIds.length === 0 && firstError !== undefined) throw firstError;
  return {
    messageId: messageIds[0] ?? '',
    messageIds,
    ...(errors.length ? { mediaErrors: errors } : {}),
  };
}

/** messageIds / mediaErrors for a multi-message media send. */
function mediaResultExtra(result: {
  messageIds: string[];
  mediaErrors?: string[];
}): Record<string, unknown> {
  return {
    ...(result.messageIds.length > 1 ? { messageIds: result.messageIds } : {}),
    ...(result.mediaErrors ? { mediaErrors: result.mediaErrors } : {}),
  };
}

/**
 * Coordinates from `latitude`+`longitude` (both required) or a
 * `location: "LAT,LNG"` / "LAT LNG" string; undefined when absent or not
 * numeric.
 */
function readLocationParams(
  params: Record<string, unknown>,
): { latitude: number; longitude: number } | undefined {
  let lat: number | undefined;
  let lng: number | undefined;
  if (params.latitude != null && params.longitude != null) {
    lat = parseFloat(String(params.latitude));
    lng = parseFloat(String(params.longitude));
  } else {
    const locationStr = readStringParam(params, 'location');
    const m = locationStr?.match(/(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)/);
    if (m) {
      lat = parseFloat(m[1]);
      lng = parseFloat(m[2]);
    }
  }
  if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) return undefined;
  return { latitude: lat, longitude: lng };
}

/** Voice delivery of audio: core's `asVoice` (or its `audioAsVoice` alias), boolean or "true". */
function readAsVoiceParam(params: Record<string, unknown>): boolean {
  return [params.asVoice, params.audioAsVoice].some(
    (value) => value === true || (typeof value === 'string' && value.trim() === 'true'),
  );
}

/** Contact card fields: contactId (MAX user id) and vcfPhone/phone next to the given name. */
function readContactParams(
  params: Record<string, unknown>,
  name: string,
): { name: string; contactId?: number; vcfPhone?: string } {
  const contactId = params.contactId != null ? Number(params.contactId) : undefined;
  const vcfPhone = readStringParam(params, 'vcfPhone') ?? readStringParam(params, 'phone');
  return {
    name,
    contactId: contactId && !isNaN(contactId) ? contactId : undefined,
    vcfPhone: vcfPhone ?? undefined,
  };
}

export const maxMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg }) => {
    const accounts = listEnabledAccounts(cfg);
    if (accounts.length === 0) {
      return null;
    }
    return {
      actions: ['send', 'edit', 'delete', 'sticker', 'sendAttachment', 'pin', 'unpin'],
      // presentation → inline keyboard + MAX markdown (presentation.ts);
      // delivery-pin → PUT /chats/{chatId}/pin on the sent message.
      capabilities: ['presentation', 'delivery-pin'],
      mediaSourceParams: { send: mediaSourceParams, sendAttachment: mediaSourceParams },
    };
  },

  extractToolSend: ({ args }: { args: Record<string, unknown> }) => {
    // Extract routing info for ALL actions (send, edit, delete, sticker)
    // Core uses extractToolSend for routing all message tool actions to plugin
    let to =
      typeof args.target === 'string'
        ? args.target
        : typeof args.to === 'string'
          ? args.to
          : typeof args.chatId === 'string'
            ? args.chatId
            : typeof args.channelId === 'string'
              ? args.channelId
              : undefined;
    if (!to) {
      // For edit/delete, target may not be present — use a placeholder
      // so core still routes to this plugin's handleAction
      to = typeof args.messageId === 'string' ? '__message_action__' : undefined;
    }
    if (!to) {
      return null;
    }
    // Strip provider prefix (e.g. "max:123456789" → "123456789")
    if (to.startsWith('max:')) to = to.slice(4);
    const accountId = typeof args.accountId === 'string' ? args.accountId.trim() : undefined;
    return { to, accountId };
  },

  handleAction: async (ctx) => {
    const { action, params, cfg, accountId } = ctx;
    const account = resolveMaxAccount({
      cfg,
      accountId,
    });
    if (!account.token) {
      throw new Error('MAX bot token not configured');
    }

    // Notification and link-preview options of sends: core's `silent` flag
    // beats the account defaults (channels.max.notify / disableLinkPreview).
    const sendFlags = resolveMaxSendFlags(account.config, {
      silent: typeof params.silent === 'boolean' ? params.silent : undefined,
    });

    // Strip provider prefix from target (e.g. "max:123456789" → "123456789")
    const stripPrefix = (val: string | undefined): string | undefined => {
      if (!val) return val;
      return val.startsWith('max:') ? val.slice(4) : val;
    };

    if (action === 'send') {
      const to = stripPrefix(readTargetParam(params))!;
      await assertMaxActionInScope(ctx, account, { to });
      const presentation = normalizeMessagePresentation(params.presentation);
      const pin = readMaxDeliveryPin(params.delivery, params.pin);
      const content =
        readStringParam(params, 'message', {
          required: !presentation,
          allowEmpty: true,
        }) ?? '';

      // Pin the sent message when delivery.pin (or pin=true) was requested.
      // Optional pin failures degrade; a required one fails the action.
      // Dialogs cannot pin: that is reported as pinned:false with pinSkipped.
      const withPin = async (
        messageId: string,
        chatType?: string,
        extra: Record<string, unknown> = {},
      ) => {
        if (!pin || !messageId) return jsonResult({ ok: true, to, messageId, ...extra });
        try {
          const pinned = await pinMaxMessage(to, messageId, {
            token: account.token,
            pinNotify: pin.notify === true,
            chatType,
          });
          if (!pinned.pinned) {
            return jsonResult({
              ok: true,
              to,
              messageId,
              ...extra,
              pinned: false,
              pinSkipped: pinned.reason,
            });
          }
          return jsonResult({ ok: true, to, messageId, ...extra, pinned: true });
        } catch (err) {
          if (pin.required) throw err;
          return jsonResult({
            ok: true,
            to,
            messageId,
            ...extra,
            pinned: false,
            pinError: String(err),
          });
        }
      };

      // Core normally renders presentation through the outbound adapter; this
      // path covers direct plugin dispatch with the same render policy.
      if (presentation) {
        const rendered = await materializeMaxPresentation({ text: content, presentation });
        const renderedButtons = readMaxChannelButtons(rendered.channelData);
        const text = rendered.text ?? '';
        const chunks =
          text.length > MAX_TEXT_LIMIT
            ? getMaxRuntime().channel.text.chunkMarkdownText(text, MAX_TEXT_LIMIT)
            : [text];
        let firstMessageId = '';
        let firstChatType: string | undefined;
        for (let index = 0; index < chunks.length; index += 1) {
          const sent = await sendMaxMessage(to, chunks[index], {
            token: account.token,
            ...sendFlags,
            replyToMessageId:
              index === 0 ? (readStringParam(params, 'replyTo') ?? undefined) : undefined,
            format: 'markdown',
            buttons: index === chunks.length - 1 ? renderedButtons : undefined,
          });
          if (index === 0) {
            firstMessageId = sent.messageId;
            firstChatType = sent.raw.message?.recipient?.chat_type;
          }
        }
        return withPin(firstMessageId, firstChatType);
      }
      const replyTo = readStringParam(params, 'replyTo');
      const stickerId = readStringParam(params, 'stickerId');

      // Inline keyboard buttons: [[{text, type?, payload?|callback_data?, url?, webApp?}]]
      // type: callback (default) | link | message | clipboard | open_app | request_contact | request_geo_location
      const buttons = readMaxSendButtons(params.buttons);

      // Sticker sending (by sticker code)
      if (stickerId) {
        // stickerId can be a single id or comma-separated
        const codes = Array.isArray(params.stickerId)
          ? (params.stickerId as string[])
          : [stickerId];
        const firstCode = codes[0];
        if (firstCode) {
          const result = await sendMaxSticker(to, firstCode, {
            token: account.token,
            ...sendFlags,
            replyToMessageId: replyTo ?? undefined,
          });
          return withPin(result.messageId, result.raw.message?.recipient?.chat_type);
        }
      }

      // Location sending: coordinates from latitude/longitude or location="LAT,LNG"
      const location = readLocationParams(params);
      if (location) {
        const result = await sendMaxLocation(to, location, content || undefined, {
          token: account.token,
          ...sendFlags,
          replyToMessageId: replyTo ?? undefined,
          format: 'markdown',
        });
        return withPin(result.messageId, result.raw.message?.recipient?.chat_type);
      }

      // Contact sending: if contactName param exists
      const contactName = readStringParam(params, 'contactName');
      if (contactName) {
        const result = await sendMaxContact(to, readContactParams(params, contactName), {
          token: account.token,
          ...sendFlags,
          replyToMessageId: replyTo ?? undefined,
        });
        return withPin(result.messageId, result.raw.message?.recipient?.chat_type);
      }

      // Media: direct media fields and every structured attachments[] item.
      const mediaMaxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
      const mediaSources = readMediaSources(params, mediaMaxBytes);

      if (mediaSources.length) {
        // Local paths only under the allowed roots (resolveActionLocalMedia);
        // public https image links go by URL, other remote media is
        // downloaded through the SSRF-guarded fetcher and uploaded.
        const result = await sendMaxMediaSources(to, content, mediaSources, {
          token: account.token,
          ...sendFlags,
          replyToMessageId: replyTo ?? undefined,
          format: 'markdown',
          mediaMaxBytes,
          localMedia: resolveActionLocalMedia(ctx),
          asVoice: readAsVoiceParam(params),
        });
        return withPin(result.messageId, result.chatType, mediaResultExtra(result));
      }

      const result = await sendMaxMessage(to, content, {
        token: account.token,
        ...sendFlags,
        replyToMessageId: replyTo ?? undefined,
        format: 'markdown',
        buttons,
      });
      return withPin(result.messageId, result.raw.message?.recipient?.chat_type);
    }

    if (action === 'edit') {
      const messageId = readStringParam(params, 'messageId', { required: true });
      await assertMaxActionInScope(ctx, account, { messageId });
      const text = readStringParam(params, 'message', {
        required: true,
        allowEmpty: true,
      });
      await editMaxMessage(messageId, text, {
        token: account.token,
        format: 'markdown',
      });
      return jsonResult({ ok: true, messageId });
    }

    if (action === 'delete') {
      const messageId = readStringParam(params, 'messageId', { required: true });
      await assertMaxActionInScope(ctx, account, { messageId });
      await deleteMaxMessage(messageId, {
        token: account.token,
      });
      return jsonResult({ ok: true, messageId });
    }

    if (action === 'pin') {
      const to = stripPrefix(readTargetParam(params))!;
      const messageId = readStringParam(params, 'messageId', { required: true });
      await assertMaxActionInScope(ctx, account, { to });
      const notifyParam = params.notify;
      const pinned = await pinMaxMessage(to, messageId, {
        token: account.token,
        pinNotify: typeof notifyParam === 'boolean' ? notifyParam : undefined,
      });
      if (!pinned.pinned) {
        return jsonResult({ ok: true, to, messageId, pinned: false, reason: pinned.reason });
      }
      return jsonResult({ ok: true, to, messageId, pinned: true });
    }

    if (action === 'unpin') {
      const to = stripPrefix(readTargetParam(params))!;
      await assertMaxActionInScope(ctx, account, { to });
      await unpinMaxMessage(to, { token: account.token });
      return jsonResult({ ok: true, to, pinned: false });
    }

    if (action === 'sticker') {
      const to = stripPrefix(readTargetParam(params))!;
      await assertMaxActionInScope(ctx, account, { to });
      // stickerId may come as string or string[] from message tool schema
      const rawStickerId = params.stickerId;
      let stickerCode: string | undefined = Array.isArray(rawStickerId)
        ? (rawStickerId[0] as string)?.trim()
        : (readStringParam(params, 'stickerId') ?? readStringParam(params, 'fileId'));
      // Auto-fill from last received sticker if not provided
      if (!stickerCode) {
        stickerCode = getLastStickerCode(to) ?? getLastStickerCode() ?? undefined;
      }
      if (!stickerCode) {
        throw new Error('stickerId is required. Send a sticker first, then ask to send it back.');
      }
      const replyTo = readStringParam(params, 'replyTo');

      const result = await sendMaxSticker(to, stickerCode, {
        token: account.token,
        ...sendFlags,
        replyToMessageId: replyTo ?? undefined,
      });
      return jsonResult({ ok: true, to, messageId: result.messageId });
    }

    if (action === 'sendAttachment') {
      const to = stripPrefix(readTargetParam(params))!;
      await assertMaxActionInScope(ctx, account, { to });
      const replyTo = readStringParam(params, 'replyTo');
      const caption =
        readStringParam(params, 'message') ?? readStringParam(params, 'caption') ?? '';
      const attachType =
        readStringParam(params, 'type') ?? readStringParam(params, 'attachmentType') ?? '';
      const mediaMaxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
      const mediaSources = readMediaSources(params, mediaMaxBytes);

      if (mediaSources.length) {
        const result = await sendMaxMediaSources(to, caption, mediaSources, {
          token: account.token,
          ...sendFlags,
          replyToMessageId: replyTo ?? undefined,
          format: 'markdown',
          mediaMaxBytes,
          localMedia: resolveActionLocalMedia(ctx),
          asVoice: readAsVoiceParam(params),
        });
        return jsonResult({
          ok: true,
          to,
          messageId: result.messageId,
          ...mediaResultExtra(result),
        });
      }

      // Location attachment
      if (
        attachType === 'location' ||
        params.latitude != null ||
        params.longitude != null ||
        readStringParam(params, 'location')
      ) {
        const location = readLocationParams(params);
        if (location) {
          const result = await sendMaxLocation(to, location, caption || undefined, {
            token: account.token,
            ...sendFlags,
            replyToMessageId: replyTo ?? undefined,
          });
          return jsonResult({ ok: true, to, messageId: result.messageId });
        }
        throw new Error("Invalid location: provide latitude/longitude or location='LAT,LNG'");
      }

      // Contact attachment
      if (attachType === 'contact' || readStringParam(params, 'contactName')) {
        const contactName =
          readStringParam(params, 'contactName') ?? readStringParam(params, 'name') ?? 'Unknown';
        const result = await sendMaxContact(to, readContactParams(params, contactName), {
          token: account.token,
          ...sendFlags,
          replyToMessageId: replyTo ?? undefined,
        });
        return jsonResult({ ok: true, to, messageId: result.messageId });
      }

      throw new Error(
        "sendAttachment: unknown type. Use media/filePath (or base64 buffer with filename) for files, or type='location' / type='contact'",
      );
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
