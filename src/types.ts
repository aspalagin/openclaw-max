/**
 * MAX Messenger Bot API — TypeScript type definitions
 * Based on https://dev.max.ru/docs-api
 */

// ─── User / Sender ─────────────────────────────────────────────

export interface User {
  /** Unique user or bot identifier */
  user_id: number;
  /** Display first name */
  first_name: string;
  /** Display last name (absent for bots) */
  last_name?: string | null;
  /** Username / bot nick (may be null for users) */
  username?: string | null;
  /** true if this is a bot */
  is_bot: boolean;
  /** Last activity Unix-time in milliseconds (may be absent) */
  last_activity_time?: number;
  /** @deprecated — use first_name + last_name */
  name?: string | null;
}

// ─── Chat ───────────────────────────────────────────────────────

export type ChatType = "dialog" | "chat" | "channel";
export type ChatStatus = "active" | "removed" | "left" | "closed";

export interface Chat {
  chat_id: number;
  type: ChatType;
  status: ChatStatus;
  title?: string | null;
  last_event_time: number;
  participants_count: number;
  owner_id?: number | null;
  is_public: boolean;
  link?: string | null;
  description?: string | null;
  /** Present only for type "dialog" */
  dialog_with_user?: User | null;
}

// ─── Recipient ──────────────────────────────────────────────────

export interface Recipient {
  /** chat_id when sent to a chat */
  chat_id?: number;
  /** chat_type */
  chat_type?: ChatType;
  /** user_id when sent to a user */
  user_id?: number;
}

// ─── Attachments ────────────────────────────────────────────────

export interface PhotoAttachment {
  type: "image";
  payload: {
    photo_id: number;
    token: string;
    url: string;
  };
}

export interface VideoAttachment {
  type: "video";
  payload: {
    token: string;
    url: string;
    id?: number;
    thumbnail?: string;
    width?: number;
    height?: number;
    duration?: number;
  };
}

export interface AudioAttachment {
  type: "audio";
  payload: {
    token: string;
    url: string;
    id?: number;
  };
}

export interface FileAttachment {
  type: "file";
  payload: {
    token: string;
    url: string;
    file_id: number;
    filename?: string;
    size?: number;
  };
}

export interface StickerAttachment {
  type: "sticker";
  payload: {
    code: string;
    url: string;
    width?: number;
    height?: number;
  };
}

export interface ContactAttachment {
  type: "contact";
  payload: {
    vcf_info?: string;
    max_info?: User;
  };
}

export interface LocationAttachment {
  type: "location";
  payload: {
    latitude: number;
    longitude: number;
  };
}

export interface ShareAttachment {
  type: "share";
  payload: {
    url?: string;
    token?: string;
  };
}

export interface InlineKeyboardAttachment {
  type: "inline_keyboard";
  payload: {
    buttons: InlineButton[][];
  };
}

export interface InlineButton {
  type: "callback" | "link" | "request_contact" | "request_geo_location" | "open_app" | "message";
  text: string;
  payload?: string;
  url?: string;
  intent?: "default" | "positive" | "negative";
}

export type Attachment =
  | PhotoAttachment
  | VideoAttachment
  | AudioAttachment
  | FileAttachment
  | StickerAttachment
  | ContactAttachment
  | LocationAttachment
  | ShareAttachment
  | InlineKeyboardAttachment;

// ─── Message ────────────────────────────────────────────────────

export interface LinkedMessage {
  type: "forward" | "reply";
  /** Sender of the linked message */
  sender?: User;
  chat_id?: number;
  message: MessageBody;
}

export interface MessageBody {
  /** Message ID */
  mid: string;
  /** Sequence number */
  seq?: number;
  /** Text content */
  text?: string | null;
  /** Attached media / keyboard / etc. */
  attachments?: Attachment[];
}

export interface Message {
  /** Sender — absent for channel posts */
  sender?: User;
  /** Recipient (chat or user) */
  recipient: Recipient;
  /** Unix-time in milliseconds */
  timestamp: number;
  /** Forwarded or replied-to message */
  link?: LinkedMessage | null;
  /** Message body */
  body: MessageBody;
  /** Stats for channel posts */
  stat?: { views: number } | null;
  /** Public URL for channel posts */
  url?: string | null;
  /** User locale in IETF BCP 47 (dialog only) */
  user_locale?: string | null;
}

// ─── Updates ────────────────────────────────────────────────────

export type UpdateType =
  | "message_created"
  | "message_callback"
  | "message_edited"
  | "message_removed"
  | "bot_added"
  | "bot_removed"
  | "bot_started"
  | "user_added"
  | "user_removed"
  | "chat_title_changed";

interface BaseUpdate {
  update_type: UpdateType;
  timestamp: number;
  user_locale?: string | null;
}

export interface MessageCreatedUpdate extends BaseUpdate {
  update_type: "message_created";
  message: Message;
}

export interface MessageEditedUpdate extends BaseUpdate {
  update_type: "message_edited";
  message: Message;
}

export interface MessageRemovedUpdate extends BaseUpdate {
  update_type: "message_removed";
  message_id: string;
  chat_id?: number;
  user_id?: number;
}

export interface MessageCallbackUpdate extends BaseUpdate {
  update_type: "message_callback";
  callback: {
    timestamp: number;
    callback_id: string;
    payload?: string;
    user: User;
    message?: Message;
  };
}

export interface BotStartedUpdate extends BaseUpdate {
  update_type: "bot_started";
  chat_id: number;
  user: User;
  payload?: string;
}

export interface BotAddedUpdate extends BaseUpdate {
  update_type: "bot_added";
  chat_id: number;
  user: User;
  is_channel: boolean;
}

export interface BotRemovedUpdate extends BaseUpdate {
  update_type: "bot_removed";
  chat_id: number;
  user: User;
  is_channel: boolean;
}

export interface UserAddedUpdate extends BaseUpdate {
  update_type: "user_added";
  chat_id: number;
  user: User;
  inviter_id?: number;
  is_channel: boolean;
}

export interface UserRemovedUpdate extends BaseUpdate {
  update_type: "user_removed";
  chat_id: number;
  user: User;
  admin_id?: number;
  is_channel: boolean;
}

export interface ChatTitleChangedUpdate extends BaseUpdate {
  update_type: "chat_title_changed";
  chat_id: number;
  user: User;
  title: string;
}

export type Update =
  | MessageCreatedUpdate
  | MessageEditedUpdate
  | MessageRemovedUpdate
  | MessageCallbackUpdate
  | BotStartedUpdate
  | BotAddedUpdate
  | BotRemovedUpdate
  | UserAddedUpdate
  | UserRemovedUpdate
  | ChatTitleChangedUpdate;

// ─── Updates Response ───────────────────────────────────────────

export interface UpdatesResponse {
  updates: Update[];
  /** Pointer to next page — pass as marker on next request */
  marker: number | null;
}

// ─── Account config (for OpenClaw plugin) ──────────────────────

export interface MaxAccountConfig {
  enabled?: boolean;
  name?: string;
  botToken?: string;
  allowFrom?: Array<string | number>;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  streaming?: "off" | "partial" | "block";
  /** Transport mode for receiving updates */
  transport?: "polling" | "webhook";
  /** Webhook URL (used when transport === "webhook") */
  webhookUrl?: string;
  /** Webhook server port (default: 9400) */
  webhookPort?: number;
  /** Require @mention in group chats (default: true) */
  requireMention?: boolean;
  /** Group chat policy */
  groupPolicy?: "allowlist" | "open" | "disabled";
  /** Allowed group chat IDs */
  allowGroups?: Array<string | number>;
}

export interface MaxChannelConfig {
  enabled?: boolean;
  defaultAccount?: string;
  /** Named accounts (multi-account support) */
  accounts?: Record<string, MaxAccountConfig>;
  /** Legacy top-level fields (single account) */
  botToken?: string;
  allowFrom?: Array<string | number>;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  streaming?: "off" | "partial" | "block";
  /** Transport mode: "polling" (default) or "webhook" */
  transport?: "polling" | "webhook";
  /** Public URL for webhook endpoint */
  webhookUrl?: string;
  /** Port for webhook HTTP server (default: 8443) */
  webhookPort?: number;
}

export interface ResolvedMaxAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  botToken: string;
  config: MaxAccountConfig;
}
