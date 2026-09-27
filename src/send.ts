/**
 * Outbound message sending for MAX.
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import {
  buildOutboundMediaLoadOptions,
  type OutboundMediaAccess,
} from 'openclaw/plugin-sdk/media-runtime';
import { retryAsync } from 'openclaw/plugin-sdk/runtime-env';
import {
  isBlockedHostnameOrIp,
  resolvePinnedHostnameWithPolicy,
} from 'openclaw/plugin-sdk/ssrf-runtime';
import { loadWebMediaRaw } from 'openclaw/plugin-sdk/web-media';

import { resolveMaxAccount } from './accounts.js';
import {
  MaxApi,
  MaxApiError,
  type MaxAttachment,
  type MaxInlineKeyboardAttachment,
  type MaxInlineKeyboardButton,
  type MaxNewMessageBody,
  MaxRequestTimeoutError,
  type MaxSendResult,
  type MaxStickerAttachment,
} from './api.js';
import { toMaxMarkdown } from './format.js';
import { downloadMaxRemoteMedia, type MaxLoadedMedia, sanitizeMaxFileName } from './media-temp.js';

export type MaxSendButton = {
  text: string;
  /** Button type; default: "link" when url is set, otherwise "callback" */
  type?:
    | 'callback'
    | 'link'
    | 'message'
    | 'clipboard'
    | 'open_app'
    | 'request_contact'
    | 'request_geo_location';
  payload?: string;
  callback_data?: string;
  url?: string;
  /** open_app: public name of the bot wired to the mini app (falls back to `url`) */
  webApp?: string;
};

export interface MaxSendOptions {
  token?: string;
  accountId?: string;
  cfg?: OpenClawConfig;
  replyToMessageId?: string;
  format?: 'markdown' | 'html';
  disableLinkPreview?: boolean;
  notify?: boolean;
  buttons?: MaxSendButton[][];
}

/** Send target: numeric chat id, or an explicit user id (user:<id> targets). */
export type MaxSendTarget = { chat_id: number } | { user_id: number };

/**
 * Resolve a token from options or config.
 */
function resolveToken(opts: MaxSendOptions): string {
  if (opts.token) return opts.token;
  if (opts.cfg) {
    const account = resolveMaxAccount({ cfg: opts.cfg, accountId: opts.accountId });
    if (account.token) return account.token;
  }
  throw new Error('MAX bot token not available');
}

/**
 * Resolve a target string into API send params.
 * Supported forms: "12345", "max:12345" (chat id), "user:12345" / "max:user:12345"
 * (user id).
 *
 * "@username" and max.ru links are rejected with an explicit error: the Bot API
 * schema has only GET /chats/{chatId} (numeric), and a link lookup answers
 * `chat.not.found` live. Address groups by chat_id (from bot_added), users by
 * "user:<id>".
 */
export async function resolveMaxTarget(_api: MaxApi, to: string): Promise<MaxSendTarget> {
  let normalized = to.trim();
  if (normalized.startsWith('max:')) normalized = normalized.slice(4);

  if (normalized.startsWith('user:')) {
    const userId = Number(normalized.slice(5));
    if (Number.isNaN(userId)) throw new Error(`Invalid MAX target: ${to}`);
    return { user_id: userId };
  }

  const chatId = Number(normalized);
  if (!Number.isNaN(chatId) && normalized !== '') {
    return { chat_id: chatId };
  }

  if (normalized.startsWith('@') || /(^|\/\/|www\.)max\.ru\//i.test(normalized)) {
    throw new Error(
      `MAX API does not resolve @username or chat links ("${to}"); ` +
        'use a numeric chat_id for chats and channels or user:<id> for users',
    );
  }

  throw new Error(`Invalid MAX target: ${to}`);
}

/** Button types the plugin builds (schema.yaml Button.discriminator). */
export const MAX_SEND_BUTTON_TYPES: ReadonlySet<string> = new Set([
  'callback',
  'link',
  'message',
  'clipboard',
  'open_app',
  'request_contact',
  'request_geo_location',
]);

/**
 * Parse loosely typed button rows (`channelData.max.buttons`, the message
 * tool's `buttons` param): [[{text|label, type?, payload?, callback_data?,
 * url?, webApp|web_app?}]]. A bare button in place of a row is one row;
 * non-object items and buttons without text are dropped.
 */
export function readMaxSendButtons(rawButtons: unknown): MaxSendButton[][] | undefined {
  if (!Array.isArray(rawButtons)) return undefined;

  const rows = rawButtons
    .map((row) => {
      const items = Array.isArray(row) ? row : [row];
      return items
        .filter(
          (button): button is Record<string, unknown> =>
            Boolean(button) && typeof button === 'object' && !Array.isArray(button),
        )
        .map((button) => ({
          text: String(button.text ?? button.label ?? ''),
          type: MAX_SEND_BUTTON_TYPES.has(String(button.type))
            ? (String(button.type) as MaxSendButton['type'])
            : undefined,
          payload: button.payload != null ? String(button.payload) : undefined,
          callback_data: button.callback_data != null ? String(button.callback_data) : undefined,
          url: button.url != null ? String(button.url) : undefined,
          webApp:
            button.webApp != null
              ? String(button.webApp)
              : button.web_app != null
                ? String(button.web_app)
                : undefined,
        }))
        .filter((button) => button.text.trim().length > 0);
    })
    .filter((row) => row.length > 0);

  return rows.length > 0 ? rows : undefined;
}

export function readMaxChannelButtons(channelData: unknown): MaxSendButton[][] | undefined {
  if (!channelData || typeof channelData !== 'object' || Array.isArray(channelData))
    return undefined;
  const maxData = (channelData as Record<string, unknown>).max;
  if (!maxData || typeof maxData !== 'object' || Array.isArray(maxData)) return undefined;
  return readMaxSendButtons((maxData as Record<string, unknown>).buttons);
}

/** Extra per-message options passed via channelData.max (notify, link preview). */
export function readMaxChannelSendOptions(channelData: unknown): {
  notify?: boolean;
  disableLinkPreview?: boolean;
} {
  if (!channelData || typeof channelData !== 'object' || Array.isArray(channelData)) return {};
  const maxData = (channelData as Record<string, unknown>).max;
  if (!maxData || typeof maxData !== 'object' || Array.isArray(maxData)) return {};
  const data = maxData as Record<string, unknown>;
  const result: { notify?: boolean; disableLinkPreview?: boolean } = {};
  if (typeof data.notify === 'boolean') result.notify = data.notify;
  if (data.silent === true) result.notify = false;
  if (typeof data.disableLinkPreview === 'boolean')
    result.disableLinkPreview = data.disableLinkPreview;
  return result;
}

function buildMaxButton(btn: MaxSendButton): MaxInlineKeyboardButton {
  const type = btn.type ?? (btn.url ? 'link' : 'callback');
  const payload = btn.payload ?? btn.callback_data;
  switch (type) {
    case 'link':
      return { type: 'link', text: btn.text, url: btn.url ?? '' };
    case 'message':
      return { type: 'message', text: btn.text, ...(payload ? { payload } : {}) };
    case 'clipboard':
      return { type: 'clipboard', text: btn.text, payload: payload ?? btn.text };
    case 'open_app': {
      // OpenAppButton has no `url`: the mini app is addressed by `web_app`
      // (the wired bot's public name). A legacy `url` is carried over there.
      const webApp = btn.webApp ?? btn.url;
      return {
        type: 'open_app',
        text: btn.text,
        ...(webApp ? { web_app: webApp } : {}),
        ...(payload ? { payload } : {}),
      };
    }
    case 'request_contact':
      return { type: 'request_contact', text: btn.text };
    case 'request_geo_location':
      return { type: 'request_geo_location', text: btn.text };
    case 'callback':
    default:
      return {
        type: 'callback',
        text: btn.text,
        payload: payload ?? btn.text,
      };
  }
}

function buildInlineKeyboard(buttons: MaxSendButton[][]): MaxInlineKeyboardAttachment {
  return {
    type: 'inline_keyboard',
    payload: {
      buttons: buttons.map((row) => row.map((btn) => buildMaxButton(btn))),
    },
  };
}

/** Apply MAX markdown dialect conversion when sending formatted text. */
function formatOutboundText(text: string, format?: 'markdown' | 'html'): string {
  if (format === 'markdown' && text) return toMaxMarkdown(text);
  return text;
}

type MaxBodyAttachments = NonNullable<MaxNewMessageBody['attachments']>;

/**
 * NewMessageBody: text (MAX markdown dialect) with its format when `text` is
 * given (attachment-only bodies carry neither), notify, attachments and the
 * reply link.
 */
/** Account defaults for notifications and link previews (config `notify`, `disableLinkPreview`). */
export interface MaxSendDefaults {
  notify?: boolean;
  disableLinkPreview?: boolean;
}

/**
 * Notification and link-preview options of one send. An explicit value of the
 * call beats the account default: core's `silent` flag first, then
 * channelData.max (`notify`, `silent`, `disableLinkPreview`). Unset fields stay
 * unset, so MAX applies its own defaults (notify on, previews on).
 */
export function resolveMaxSendFlags(
  defaults: MaxSendDefaults,
  explicit: { silent?: boolean; channelData?: unknown } = {},
): { notify?: boolean; disableLinkPreview?: boolean } {
  const fromData = readMaxChannelSendOptions(explicit.channelData);
  const notify =
    typeof explicit.silent === 'boolean' ? !explicit.silent : (fromData.notify ?? defaults.notify);
  const disableLinkPreview = fromData.disableLinkPreview ?? defaults.disableLinkPreview;
  return {
    ...(notify !== undefined ? { notify } : {}),
    ...(disableLinkPreview !== undefined ? { disableLinkPreview } : {}),
  };
}

function buildMaxBody(
  opts: MaxSendOptions,
  text: string | undefined,
  attachments?: MaxBodyAttachments,
): MaxNewMessageBody {
  const body: MaxNewMessageBody =
    text === undefined
      ? { notify: opts.notify }
      : {
          text: formatOutboundText(text, opts.format) || undefined,
          format: opts.format ?? undefined,
          notify: opts.notify,
        };
  if (attachments?.length) body.attachments = attachments;
  if (opts.replyToMessageId) {
    body.link = { type: 'reply', mid: opts.replyToMessageId };
  }
  return body;
}

/** Text body with the inline keyboard from `opts.buttons`. */
function buildMaxTextBody(text: string, opts: MaxSendOptions = {}): MaxNewMessageBody {
  return buildMaxBody(
    opts,
    text,
    opts.buttons?.length ? [buildInlineKeyboard(opts.buttons)] : undefined,
  );
}

function buildSendParams(
  target: MaxSendTarget,
  opts: MaxSendOptions,
): { chat_id?: number; user_id?: number; disable_link_preview?: boolean } {
  const params: { chat_id?: number; user_id?: number; disable_link_preview?: boolean } = {
    ...target,
  };
  if (opts.disableLinkPreview) {
    params.disable_link_preview = true;
  }
  return params;
}

export type MaxSendOutcome = { messageId: string; raw: MaxSendResult };

/**
 * The one POST /messages path of every send* helper: resolve the target, build
 * the body (after the target, so a bad target fails before any upload), send —
 * the per-chat limiter lives in MaxApi.sendMessage — through the caller's retry
 * policy, and report the sent mid. typing_on is not sent here: the inbound
 * pipeline keeps it up for the agent turn.
 */
async function sendWithBody(params: {
  api: MaxApi;
  to: string;
  opts: MaxSendOptions;
  body: MaxNewMessageBody | (() => Promise<MaxNewMessageBody>);
  retry?: (send: () => Promise<MaxSendResult>) => Promise<MaxSendResult>;
}): Promise<MaxSendOutcome> {
  const { api, to, opts, retry } = params;
  const target = await resolveMaxTarget(api, to);
  let body = typeof params.body === 'function' ? await params.body() : params.body;
  // MAX channels publish only with notifications (POST /messages: notify must
  // be true or absent for a channel), so a silent send into a channel notifies.
  if (body.notify === false && 'chat_id' in target && (await isMaxChannel(api, target.chat_id))) {
    body = { ...body, notify: undefined };
  }
  const sendTo = (to: MaxSendTarget) => {
    const sendParams = buildSendParams(to, opts);
    const send = () => api.sendMessage(body, sendParams);
    return retry ? retry(send) : send();
  };
  let result: MaxSendResult;
  try {
    result = await sendTo(target);
  } catch (err) {
    // A bare positive number is ambiguous: agents often pass a user id where
    // a chat id is expected (the directory hands out user ids of DM peers).
    // MAX rejected the send outright, so nothing was delivered and one retry
    // as user_id cannot duplicate.
    if (!('chat_id' in target) || target.chat_id <= 0 || !isChatNotFound(err)) throw err;
    result = await sendTo({ user_id: target.chat_id });
  }
  return {
    messageId: result.message?.body?.mid ?? '',
    raw: result,
  };
}

/** Chat id → is a channel. A chat never changes its type, so this is never invalidated. */
const channelChats = new Map<number, boolean>();

/**
 * Whether chat_id names a MAX channel (GET /chats/{chatId}, cached). A chat
 * the bot does not know is not a channel (the send falls back to user_id);
 * after any other lookup failure assume a channel: a notified post is better
 * than a send MAX rejects.
 */
async function isMaxChannel(api: MaxApi, chatId: number): Promise<boolean> {
  const cached = channelChats.get(chatId);
  if (cached !== undefined) return cached;
  let isChannel: boolean;
  try {
    isChannel = (await api.getChat(chatId)).type === 'channel';
  } catch (err) {
    if (!isChatNotFound(err)) return true;
    isChannel = false;
  }
  if (channelChats.size >= 1000) channelChats.clear();
  channelChats.set(chatId, isChannel);
  return isChannel;
}

/** MAX answer for a chat_id that names no chat of the bot (e.g. a user id). */
export function isChatNotFound(err: unknown): boolean {
  if (!(err instanceof MaxApiError)) return false;
  if (err.code === 'dialog.not.found' || err.code === 'chat.not.found') return true;
  return /\b(dialog|chat)\.not\.found\b/.test(err.message);
}

/**
 * A client-side timeout aborts before the request reaches MAX: aborted sends
 * never appear in the chat and never duplicate (verified against the live chat
 * history). So one retry on a fresh connection is duplicate-safe and recovers
 * the intermittent in-process send stall. Scoped to text sends on purpose —
 * media is not retried here to avoid re-uploading the file.
 */
async function retryOnceOnTimeout(send: () => Promise<MaxSendResult>): Promise<MaxSendResult> {
  try {
    return await send();
  } catch (err) {
    if (!(err instanceof MaxRequestTimeoutError)) throw err;
    console.error(
      `[MAX] send timed out after ${err.elapsedMs}ms (phase=${err.phase}); retrying once`,
    );
    return send();
  }
}

/** MAX processes video/file uploads asynchronously: retry the send (not the upload) while attachment.not.ready. */
function retryWhileAttachmentNotReady(send: () => Promise<MaxSendResult>): Promise<MaxSendResult> {
  return retryAsync(send, {
    attempts: 6,
    minDelayMs: 1_500,
    maxDelayMs: 4_000,
    label: 'MAX send media (attachment.not.ready)',
    shouldRetry: (err) => isAttachmentNotReady(err),
  });
}

/**
 * MAX refused a formatted text request as a whole (400) for a reason other
 * than the target, an unready attachment or a dialog-only restriction, so the
 * likely cause is the markup. MAX documents no dedicated code for bad markup:
 * the known unrelated refusals are excluded instead. A 400 means nothing was
 * created, so one plain-text resend cannot duplicate the message.
 */
export function isMaxFormatRejection(err: unknown): boolean {
  if (!(err instanceof MaxApiError) || err.status !== 400) return false;
  return !isChatNotFound(err) && !isAttachmentNotReady(err) && !isPinUnavailableForDialog(err);
}

/**
 * Run a formatted text request; when MAX refuses the markup, repeat it once
 * without `format` (the text goes as written). The second failure propagates.
 */
async function withPlainTextFallback<T>(
  text: string,
  opts: MaxSendOptions,
  attempt: (opts: MaxSendOptions) => Promise<T>,
): Promise<T> {
  try {
    return await attempt(opts);
  } catch (err) {
    if (!opts.format || !text.trim() || !isMaxFormatRejection(err)) throw err;
    const code = err instanceof MaxApiError ? (err.code ?? err.status) : '';
    console.warn(`[MAX] ${opts.format} refused (${code}); resending as plain text`);
    return attempt({ ...opts, format: undefined });
  }
}

/**
 * Send a text message to a MAX chat or user. A markup refusal is retried
 * once as plain text.
 */
export async function sendMaxMessage(
  to: string,
  text: string,
  opts: MaxSendOptions = {},
): Promise<MaxSendOutcome> {
  const api = new MaxApi({ token: resolveToken(opts) });
  return withPlainTextFallback(text, opts, (sendOpts) =>
    sendWithBody({
      api,
      to,
      opts: sendOpts,
      body: buildMaxTextBody(text, sendOpts),
      retry: retryOnceOnTimeout,
    }),
  );
}

/**
 * Answer a MAX callback. Unlike /messages, /answers is scoped by callback_id
 * and works even when the callback update does not expose a sendable chat_id.
 */
export async function answerMaxCallback(
  callbackId: string,
  text: string,
  opts: MaxSendOptions & { notification?: string } = {},
): Promise<void> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });
  await withPlainTextFallback(text, opts, async (answerOpts) => {
    await api.answerCallback(callbackId, {
      ...(text || opts.buttons?.length ? { message: buildMaxTextBody(text, answerOpts) } : {}),
      ...(opts.notification ? { notification: opts.notification } : {}),
    });
  });
}

/**
 * Edit an existing MAX message. PUT /messages keeps the current attachments
 * when `attachments` is absent/null and deletes them all on an empty list, so
 * the keyboard is sent only when `buttons` are given (it then replaces the
 * message attachments, e.g. adds buttons to a text-only stream draft). A
 * markup refusal is retried once as plain text.
 */
export async function editMaxMessage(
  messageId: string,
  text: string,
  opts: MaxSendOptions = {},
): Promise<void> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });

  await withPlainTextFallback(text, opts, async (editOpts) => {
    await api.editMessage(messageId, {
      text: formatOutboundText(text, editOpts.format),
      format: editOpts.format ?? undefined,
      ...(opts.buttons?.length ? { attachments: [buildInlineKeyboard(opts.buttons)] } : {}),
    });
  });
}

/**
 * Delete a MAX message.
 */
export async function deleteMaxMessage(
  messageId: string,
  opts: MaxSendOptions = {},
): Promise<void> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });

  await api.deleteMessage(messageId);
}

/** Pin result: MAX has no pinned messages in dialogs (1:1 chats). */
export type MaxPinOutcome = { pinned: true } | { pinned: false; reason: string };

export const MAX_PIN_DIALOG_REASON = 'MAX does not support pinned messages in dialogs';

/** 400 proto.payload "Method is not available for dialogs" from /chats/{id}/pin. */
function isPinUnavailableForDialog(err: unknown): boolean {
  if (!(err instanceof MaxApiError)) return false;
  const message =
    typeof (err.body as { message?: unknown })?.message === 'string'
      ? String((err.body as { message?: unknown }).message)
      : err.message;
  return /not available for dialogs/i.test(message);
}

/**
 * Pin a message in a MAX chat. Dialogs cannot have pinned messages (MAX
 * answers 400 "Method is not available for dialogs"), so a dialog target is
 * reported as `{ pinned: false }` without calling the pin API: `user:<id>`
 * targets are always dialogs, negative ids are groups/channels, and a
 * positive chat id is checked through `chatType` (the recipient of the sent
 * message) or GET /chats/{id}.
 */
export async function pinMaxMessage(
  to: string,
  messageId: string,
  opts: MaxSendOptions & {
    pinNotify?: boolean;
    /** recipient.chat_type of the sent message, when the caller has it. */
    chatType?: string;
    /** Checked synchronously right before each MAX request (delivery-owner guard). */
    beforeRequest?: () => void;
  } = {},
): Promise<MaxPinOutcome> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });
  const target = await resolveMaxTarget(api, to);
  if (!('chat_id' in target) || opts.chatType === 'dialog') {
    return { pinned: false, reason: MAX_PIN_DIALOG_REASON };
  }
  const chatId = target.chat_id;
  if (chatId > 0 && !opts.chatType) {
    opts.beforeRequest?.();
    const chatType = await api.getChat(chatId).then(
      (chat) => chat.type,
      () => undefined, // unknown: let the pin call decide
    );
    if (chatType === 'dialog') return { pinned: false, reason: MAX_PIN_DIALOG_REASON };
  }
  opts.beforeRequest?.();
  try {
    await api.pinMessage(chatId, messageId, opts.pinNotify);
  } catch (err) {
    if (isPinUnavailableForDialog(err)) return { pinned: false, reason: MAX_PIN_DIALOG_REASON };
    throw err;
  }
  return { pinned: true };
}

export async function unpinMaxMessage(to: string, opts: MaxSendOptions = {}): Promise<void> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });
  const target = await resolveMaxTarget(api, to);
  if (!('chat_id' in target)) throw new Error('MAX unpin requires a chat id target');
  await api.unpinMessage(target.chat_id);
}

// Extension → upload type routing. Everything else goes as a generic file.
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'heic', 'tif', 'tiff', 'bmp'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm'];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'];

export function detectMaxMediaType(mediaPath: string): 'image' | 'video' | 'audio' | 'file' {
  const ext = mediaPath.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  return 'file';
}

function isAttachmentNotReady(err: unknown): boolean {
  if (!(err instanceof MaxApiError)) return false;
  if (err.code === 'attachment.not.ready') return true;
  const message =
    typeof (err.body as { message?: unknown })?.message === 'string'
      ? String((err.body as { message?: unknown }).message)
      : '';
  return /not\s*\.?\s*ready|not processed/i.test(message);
}

/** Images and videos per message (docs «Медиафайлы»: up to 12 in total). */
export const MAX_VISUAL_MEDIA_PER_MESSAGE = 12;

const DEFAULT_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Host media access for local files, as core hands it to message actions and
 * the outbound adapter (ChannelMessageActionContext / ChannelOutboundContext).
 */
export interface MaxLocalMediaAccess {
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
}

export interface MaxMediaSendOptions extends MaxSendOptions {
  /** Size cap for media that has to be uploaded (default 20 MB). */
  mediaMaxBytes?: number;
  /**
   * Allowed roots and host reader for local paths. A local path is read only
   * through core's guarded loader under these roots (realpath containment, so
   * `..` and symlinks cannot escape); without them the gateway's default
   * media roots apply.
   */
  localMedia?: MaxLocalMediaAccess;
}

function isRemoteUrl(source: string): boolean {
  return source.startsWith('https://') || source.startsWith('http://');
}

/** https link whose path looks like an image: MAX can fetch it itself (image.payload.url). */
function isImageLink(source: string): boolean {
  if (!source.startsWith('https://')) return false;
  try {
    return detectMaxMediaType(new URL(source).pathname) === 'image';
  } catch {
    return false;
  }
}

/**
 * An image link handed to MAX by URL must point to a public host: not a
 * private, loopback, link-local or metadata address, also after DNS
 * resolution. Anything else is downloaded through the guarded fetcher (which
 * refuses such hosts as well) and uploaded.
 */
async function isPublicImageLink(source: string): Promise<boolean> {
  if (!isImageLink(source)) return false;
  try {
    const { hostname } = new URL(source);
    if (isBlockedHostnameOrIp(hostname)) return false;
    await resolvePinnedHostnameWithPolicy(hostname);
    return true;
  } catch {
    return false;
  }
}

function mediaKind(source: string): 'image' | 'video' | 'audio' | 'file' {
  if (!isRemoteUrl(source)) return detectMaxMediaType(source);
  try {
    return detectMaxMediaType(new URL(source).pathname);
  } catch {
    return 'file';
  }
}

/**
 * A local media file through core's guarded loader (loadWebMediaRaw): only
 * under the allowed roots, through the host reader when core passed one,
 * capped at the media size limit. A path outside the roots fails with
 * LocalMediaAccessError ("Local media path is not under an allowed
 * directory") before any byte is read.
 */
async function loadLocalMaxMedia(
  source: string,
  opts: MaxMediaSendOptions,
): Promise<MaxLoadedMedia> {
  const loaded = await loadWebMediaRaw(
    source,
    buildOutboundMediaLoadOptions({
      maxBytes: opts.mediaMaxBytes ?? DEFAULT_MEDIA_MAX_BYTES,
      mediaAccess: opts.localMedia?.mediaAccess,
      mediaLocalRoots: opts.localMedia?.mediaLocalRoots,
      mediaReadFile: opts.localMedia?.mediaReadFile,
      optimizeImages: false,
    }),
  );
  return {
    buffer: loaded.buffer,
    contentType: loaded.contentType,
    fileName: sanitizeMaxFileName(loaded.fileName, loaded.contentType),
  };
}

/** Upload a local path (guarded loader) or a remote URL (SSRF-guarded download). */
async function uploadMaxAttachment(
  api: MaxApi,
  source: string,
  opts: MaxMediaSendOptions,
): Promise<MaxAttachment> {
  const media = isRemoteUrl(source)
    ? await downloadMaxRemoteMedia(source, opts.mediaMaxBytes ?? DEFAULT_MEDIA_MAX_BYTES)
    : await loadLocalMaxMedia(source, opts);
  const type = detectMaxMediaType(media.fileName);
  const uploaded = await api.uploadMedia(type, media.buffer, media.contentType, media.fileName);
  return { type, payload: { token: uploaded.token } };
}

/**
 * One message with the given media. Image links to public https hosts go as
 * image.payload.url (no download/upload round trip); if MAX refuses the
 * message, those links are uploaded and the message is sent once more. MAX
 * processes video/file uploads asynchronously — sendMessage may answer
 * attachment.not.ready for a few seconds; retry the send (not the upload).
 */
async function sendMaxAttachmentsMessage(
  api: MaxApi,
  to: string,
  caption: string,
  sources: string[],
  opts: MaxMediaSendOptions,
): Promise<MaxSendOutcome> {
  const links = await Promise.all(sources.map(isPublicImageLink));
  const build = async (allowLinks: boolean): Promise<MaxNewMessageBody> => {
    const attachments: MaxAttachment[] = [];
    for (const [index, source] of sources.entries()) {
      attachments.push(
        allowLinks && links[index]
          ? { type: 'image', payload: { url: source } }
          : await uploadMaxAttachment(api, source, opts),
      );
    }
    if (opts.buttons?.length) {
      attachments.push(buildInlineKeyboard(opts.buttons) as unknown as MaxAttachment);
    }
    return buildMaxBody(opts, caption, attachments);
  };
  const send = (allowLinks: boolean) =>
    sendWithBody({
      api,
      to,
      opts,
      body: () => build(allowLinks),
      retry: retryWhileAttachmentNotReady,
    });

  if (!links.some(Boolean)) return send(false);
  try {
    return await send(true);
  } catch (err) {
    if (!(err instanceof MaxApiError)) throw err;
    console.warn(`[MAX] image by URL refused (${err.code ?? err.status}); uploading instead`);
    return send(false);
  }
}

/**
 * Send a media message to MAX (with upload).
 * @param to Chat ID or user ID
 * @param caption Text caption
 * @param mediaPath Local file path (under the allowed roots) or URL (public https image links are sent by URL)
 * @param opts Send options
 */
export async function sendMaxMediaMessage(
  to: string,
  caption: string,
  mediaPath: string,
  opts: MaxMediaSendOptions = {},
): Promise<MaxSendOutcome> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });
  return sendMaxAttachmentsMessage(api, to, caption, [mediaPath], opts);
}

/**
 * Split media into messages MAX accepts: consecutive images/videos go together
 * (up to 12 per message, an album), audio and files one per message. Order is
 * kept.
 */
export function groupMaxMedia(sources: string[]): string[][] {
  const groups: string[][] = [];
  let album: string[] = [];
  const flush = () => {
    if (album.length) groups.push(album);
    album = [];
  };
  for (const source of sources) {
    const kind = mediaKind(source);
    if (kind === 'image' || kind === 'video') {
      if (album.length >= MAX_VISUAL_MEDIA_PER_MESSAGE) flush();
      album.push(source);
    } else {
      flush();
      groups.push([source]);
    }
  }
  flush();
  return groups;
}

/**
 * Send several media as few messages as MAX allows (albums of up to 12
 * images/videos). Caption and reply link go on the first message, buttons on
 * the last. Without `onError` the first failure throws; with it, a failed
 * message is reported and the rest are still sent.
 */
export async function sendMaxMediaGroup(
  to: string,
  caption: string,
  sources: string[],
  opts: MaxMediaSendOptions & { onError?: (err: unknown, sources: string[]) => void } = {},
): Promise<{ messageIds: string[] }> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });
  const { onError, ...sendOpts } = opts;
  const groups = groupMaxMedia(sources);
  const messageIds: string[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    const first = index === 0;
    const last = index === groups.length - 1;
    try {
      const sent = await sendMaxAttachmentsMessage(api, to, first ? caption : '', groups[index], {
        ...sendOpts,
        replyToMessageId: first ? sendOpts.replyToMessageId : undefined,
        buttons: last ? sendOpts.buttons : undefined,
      });
      if (sent.messageId) messageIds.push(sent.messageId);
    } catch (err) {
      if (!onError) throw err;
      onError(err, groups[index]);
    }
  }
  return { messageIds };
}

/**
 * Send a contact attachment to MAX.
 */
export async function sendMaxContact(
  to: string,
  contact: { name: string; contactId?: number; vcfPhone?: string; vcfInfo?: string },
  opts: MaxSendOptions = {},
): Promise<MaxSendOutcome> {
  const api = new MaxApi({ token: resolveToken(opts) });

  // MAX API requires either contact_id (MAX user_id) or vcf_info (VCard string)
  // Without either, returns 400 "Missing info for contact attachment".
  // Field names follow ContactAttachmentRequestPayload (snake_case).
  const payload: Record<string, unknown> = { name: contact.name };
  if (contact.contactId != null) {
    payload.contact_id = contact.contactId;
    if (contact.vcfPhone) payload.vcf_phone = contact.vcfPhone;
  } else if (contact.vcfInfo) {
    payload.vcf_info = contact.vcfInfo;
  } else {
    // Generate VCard from name + phone
    // Use literal \n escape sequence for JSON serialization
    const vcfParts = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${contact.name}`];
    if (contact.vcfPhone) vcfParts.push(`TEL:${contact.vcfPhone}`);
    vcfParts.push('END:VCARD');
    payload.vcf_info = vcfParts.join('\n');
  }

  return sendWithBody({
    api,
    to,
    opts,
    body: buildMaxBody(opts, undefined, [{ type: 'contact', payload }]),
  });
}

/**
 * Send a location attachment to MAX.
 */
export async function sendMaxLocation(
  to: string,
  location: { latitude: number; longitude: number },
  text?: string,
  opts: MaxSendOptions = {},
): Promise<MaxSendOutcome> {
  const api = new MaxApi({ token: resolveToken(opts) });
  const attachment: MaxAttachment = {
    type: 'location',
    latitude: location.latitude,
    longitude: location.longitude,
  };
  return sendWithBody({
    api,
    to,
    opts,
    body: buildMaxBody(opts, text ?? '', [attachment]),
  });
}

/**
 * Send a sticker to MAX by sticker code.
 * Sticker codes come from incoming sticker attachments (payload.code).
 */
export async function sendMaxSticker(
  to: string,
  stickerCode: string,
  opts: MaxSendOptions = {},
): Promise<MaxSendOutcome> {
  const api = new MaxApi({ token: resolveToken(opts) });
  const stickerAttachment: MaxStickerAttachment = {
    type: 'sticker',
    payload: { code: stickerCode },
  };
  return sendWithBody({
    api,
    to,
    opts,
    body: buildMaxBody(opts, undefined, [stickerAttachment]),
  });
}
