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
import { materializeMaxPresentation, MAX_TEXT_LIMIT, readMaxDeliveryPin } from './presentation.js';
import { getMaxRuntime } from './runtime.js';
import {
  deleteMaxMessage,
  editMaxMessage,
  type MaxLocalMediaAccess,
  type MaxMediaSendOptions,
  pinMaxMessage,
  readMaxChannelButtons,
  readMaxSendButtons,
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
 */
function readMediaSources(params: Record<string, unknown>): string[] {
  const sources: string[] = [];
  const add = (value: string | undefined) => {
    if (value && !sources.includes(value)) sources.push(value);
  };

  for (const key of mediaSourceKeys) {
    const value = readStringParam(params, key, { trim: false });
    if (value) {
      add(value);
      break;
    }
  }

  if (Array.isArray(params.attachments)) {
    for (const item of params.attachments) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const attachment = item as Record<string, unknown>;
      for (const key of mediaSourceKeys) {
        const value = typeof attachment[key] === 'string' ? attachment[key] : undefined;
        if (value) {
          add(value);
          break;
        }
      }
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
  sources: string[],
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
      errors.push(`${failed.join(', ')}: ${String(err)}`);
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
    // Strip provider prefix (e.g. "max:188862440" → "188862440")
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

    // Strip provider prefix from target (e.g. "max:188862440" → "188862440")
    const stripPrefix = (val: string | undefined): string | undefined => {
      if (!val) return val;
      return val.startsWith('max:') ? val.slice(4) : val;
    };

    if (action === 'send') {
      const to = stripPrefix(readTargetParam(params))!;
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
          replyToMessageId: replyTo ?? undefined,
        });
        return withPin(result.messageId, result.raw.message?.recipient?.chat_type);
      }

      // Media: direct media fields and every structured attachments[] item.
      const mediaSources = readMediaSources(params);

      if (mediaSources.length) {
        // Local paths only under the allowed roots (resolveActionLocalMedia);
        // public https image links go by URL, other remote media is
        // downloaded through the SSRF-guarded fetcher and uploaded.
        const result = await sendMaxMediaSources(to, content, mediaSources, {
          token: account.token,
          replyToMessageId: replyTo ?? undefined,
          format: 'markdown',
          mediaMaxBytes: (account.config.mediaMaxMb ?? 20) * 1024 * 1024,
          localMedia: resolveActionLocalMedia(ctx),
        });
        return withPin(result.messageId, result.chatType, mediaResultExtra(result));
      }

      const result = await sendMaxMessage(to, content, {
        token: account.token,
        replyToMessageId: replyTo ?? undefined,
        format: 'markdown',
        buttons,
      });
      return withPin(result.messageId, result.raw.message?.recipient?.chat_type);
    }

    if (action === 'edit') {
      const messageId = readStringParam(params, 'messageId', { required: true });
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
      await deleteMaxMessage(messageId, {
        token: account.token,
      });
      return jsonResult({ ok: true, messageId });
    }

    if (action === 'pin') {
      const to = stripPrefix(readTargetParam(params))!;
      const messageId = readStringParam(params, 'messageId', { required: true });
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
      await unpinMaxMessage(to, { token: account.token });
      return jsonResult({ ok: true, to, pinned: false });
    }

    if (action === 'sticker') {
      const to = stripPrefix(readTargetParam(params))!;
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
        replyToMessageId: replyTo ?? undefined,
      });
      return jsonResult({ ok: true, to, messageId: result.messageId });
    }

    if (action === 'sendAttachment') {
      const to = stripPrefix(readTargetParam(params))!;
      const replyTo = readStringParam(params, 'replyTo');
      const caption =
        readStringParam(params, 'message') ?? readStringParam(params, 'caption') ?? '';
      const attachType =
        readStringParam(params, 'type') ?? readStringParam(params, 'attachmentType') ?? '';
      const mediaSources = readMediaSources(params);

      if (mediaSources.length) {
        const result = await sendMaxMediaSources(to, caption, mediaSources, {
          token: account.token,
          replyToMessageId: replyTo ?? undefined,
          format: 'markdown',
          mediaMaxBytes: (account.config.mediaMaxMb ?? 20) * 1024 * 1024,
          localMedia: resolveActionLocalMedia(ctx),
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
          replyToMessageId: replyTo ?? undefined,
        });
        return jsonResult({ ok: true, to, messageId: result.messageId });
      }

      throw new Error(
        "sendAttachment: unknown type. Use media/filePath for files, or type='location' / type='contact'",
      );
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
