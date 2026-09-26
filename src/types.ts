/**
 * MAX Messenger Bot API — TypeScript type definitions
 * Based on https://dev.max.ru/docs-api
 */

// ─── MAX API Client Types (для api.ts) ────────────────────────

export interface MaxUser {
  user_id: number;
  first_name: string;
  last_name?: string | null;
  username?: string | null;
  is_bot: boolean;
  last_activity_time?: number;
  name?: string | null;
  description?: string | null;
  avatar_url?: string;
  full_avatar_url?: string;
  commands?: MaxBotCommand[] | null;
}

export interface MaxChat {
  chat_id: number;
  type: 'dialog' | 'chat' | 'channel';
  status: string;
  title?: string | null;
  icon?: { url?: string } | null;
  last_event_time?: number;
  participants_count?: number;
  owner_id?: number;
  participants?: Record<string, unknown>;
  is_public?: boolean;
  link?: string;
  description?: string | null;
  dialog_with_user?: MaxUser;
  messages_count?: number;
  chat_message_id?: string;
  pinned_message?: MaxMessage | null;
}

export interface MaxRecipient {
  chat_id?: number;
  chat_type?: string;
  user_id?: number;
  /** Post identifier for comments */
  post_id?: string | null;
}

export interface MaxMessageBody {
  mid: string;
  seq?: number;
  text?: string | null;
  attachments?: MaxAttachment[];
  /** Text markup (MarkupElement[]); user mentions arrive as `user_mention` */
  markup?: MaxMarkupElement[] | null;
}

/**
 * MarkupElement (schema.yaml). `from`/`length` index into `text`. A
 * `user_mention` carries `user_link` (`@username`) or, for users without a
 * username, `user_id`; `link` carries `url`.
 */
export interface MaxMarkupElement {
  type: string;
  from: number;
  length: number;
  user_link?: string | null;
  user_id?: number | null;
  url?: string;
}

export interface MaxAttachment {
  type: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * LinkedMessage (schema.yaml): the forwarded or replied-to message. `message`
 * is a MessageBody (mid, text, attachments, markup), not a full Message;
 * `sender` is null for posts made on behalf of a channel.
 */
export interface MaxLinkedMessage {
  type: 'forward' | 'reply';
  sender?: MaxUser | null;
  chat_id?: number;
  message?: MaxMessageBody | null;
}

export interface MaxUpdatesResponse {
  updates: MaxUpdate[];
  marker: number | null;
}

export interface MaxUploadResult {
  [key: string]: unknown;
}

export type MaxUpdateType =
  | 'message_created'
  | 'message_callback'
  | 'message_edited'
  | 'message_removed'
  | 'comment_created'
  | 'comment_edited'
  | 'comment_removed'
  | 'bot_added'
  | 'bot_removed'
  | 'bot_started'
  | 'bot_stopped'
  | 'dialog_cleared'
  | 'dialog_removed'
  | 'dialog_muted'
  | 'dialog_unmuted'
  | 'user_added'
  | 'user_removed'
  | 'chat_title_changed'
  | 'bot_admin_permissions_changed';

export interface MaxUpdate {
  update_type: MaxUpdateType;
  timestamp: number;
  /** message_callback: the keyboard's message, null when it was deleted */
  message?: MaxMessage | null;
  callback?: MaxCallback;
  chat_id?: number;
  user?: MaxUser;
  user_id?: number;
  inviter_id?: number;
  /** bot_started deeplink payload / message_removed message_id etc. */
  payload?: string | null;
  title?: string;
  is_channel?: boolean;
  user_locale?: string | null;
  [key: string]: unknown;
}

export interface MaxInlineKeyboardButton {
  type:
    | 'callback'
    | 'link'
    | 'request_contact'
    | 'request_geo_location'
    | 'open_app'
    | 'message'
    | 'clipboard';
  text: string;
  payload?: string;
  url?: string;
  /** open_app: public name of the bot wired to the mini app (required for open_app) */
  web_app?: string;
  /** open_app: id of the bot wired to the mini app */
  contact_id?: number | null;
}

export interface MaxInlineKeyboardAttachment {
  type: 'inline_keyboard';
  payload: {
    buttons: MaxInlineKeyboardButton[][];
  };
}

export interface MaxStickerAttachment {
  type: 'sticker';
  payload: {
    code: string;
  };
}

export interface MaxNewMessageBody {
  text?: string | null;
  attachments?: (MaxAttachment | MaxInlineKeyboardAttachment | MaxStickerAttachment)[] | null;
  link?: { type: 'forward' | 'reply'; mid: string } | null;
  notify?: boolean;
  format?: 'markdown' | 'html' | null;
}

export interface MaxBotCommand {
  name: string;
  description?: string;
}

/** PATCH /me/commands response (BotCommandsInfo). */
export interface MaxBotCommandsInfo {
  commands?: MaxBotCommand[] | null;
}

/**
 * Chat actions (POST /chats/{chatId}/actions).
 * mark_seen disappeared from the current docs but is still accepted; treat as legacy.
 */
export type MaxSenderAction =
  'typing_on' | 'sending_photo' | 'sending_video' | 'sending_audio' | 'sending_file' | 'mark_seen';

/** GET /chats/{chatId}/members/me */
export interface MaxChatMember {
  user_id: number;
  first_name?: string;
  last_name?: string | null;
  username?: string | null;
  is_bot?: boolean;
  is_owner?: boolean;
  is_admin?: boolean;
  join_time?: number;
  permissions?: string[] | null;
}

/** GET /videos/{videoToken} — playback info; urls may be null while processing. */
export interface MaxVideoInfo {
  token?: string;
  urls?: {
    mp4_1080?: string;
    mp4_720?: string;
    mp4_480?: string;
    mp4_360?: string;
    mp4_240?: string;
    mp4_144?: string;
    hls?: string;
  } | null;
  /** PhotoAttachmentPayload */
  thumbnail?: { url: string; photo_id?: number; token?: string } | null;
  width?: number;
  height?: number;
  duration?: number;
}

export interface MaxMessage {
  sender?: MaxUser;
  recipient: MaxRecipient;
  timestamp: number;
  link?: MaxLinkedMessage | null;
  /** Null when the message consists only of a forward (content in link.message). */
  body: MaxMessageBody | null;
  stat?: { views?: number } | null;
  url?: string | null;
}

/** Callback object; the keyboard's message arrives next to it in the update, not inside. */
export interface MaxCallback {
  timestamp: number;
  callback_id: string;
  payload?: string;
  user: MaxUser;
}

export interface MaxSendResult {
  message: MaxMessage;
}

export interface MaxSimpleResult {
  success: boolean;
  message?: string;
}

/** GET /subscriptions item. The secret is write-only (POST /subscriptions) and never returned. */
export interface MaxSubscription {
  url: string;
  time: number;
  update_types?: string[] | null;
}

export interface MaxSubscriptionsResponse {
  subscriptions: MaxSubscription[];
}

export interface MaxUploadUrlResponse {
  url: string;
  token?: string;
}
