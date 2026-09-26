/**
 * Shared monitor contracts: options every transport and handler receives,
 * the gateway status patch shape, and the update types this channel consumes.
 */

import type { ChannelAccountSnapshot, ChannelLogSink } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import type { MaxAccountConfig, ResolvedMaxAccount } from "./accounts.js";
import type { MaxApi, MaxUpdateType } from "./api.js";
import type { MaxStateStore } from "./state.js";
import type { RegisterMaxWebhookRoute } from "./webhook.js";

/**
 * Runtime status patches published to the gateway. Activity timestamps are not
 * enough: the gateway leaves an account in `lifecycle: "starting"` until the
 * transport reports `connected`, and its health policy can only detect a dead
 * socket from `lastTransportActivityAt`.
 */
export type MaxStatusPatch = Partial<ChannelAccountSnapshot>;

export interface MaxMonitorOptions {
  api: MaxApi;
  account: ResolvedMaxAccount;
  config: OpenClawConfig;
  abortSignal: AbortSignal;
  botUserId?: number;
  botUsername?: string;
  log?: ChannelLogSink;
  statusSink?: (patch: MaxStatusPatch) => void;
  /** Persistent marker + chat registry (created by startMaxPolling when absent) */
  state?: MaxStateStore;
  /** Gateway route registration; defaults to plugin-sdk registerPluginHttpRoute (tests inject a mock) */
  registerWebhookRoute?: RegisterMaxWebhookRoute;
}

/**
 * Update types this channel consumes. Shared by long polling (types filter)
 * and webhook subscriptions (update_types).
 */
export const MAX_SUBSCRIBED_UPDATE_TYPES: MaxUpdateType[] = [
  "message_created",
  "message_callback",
  "message_edited",
  "message_removed",
  "bot_started",
  "bot_stopped",
  "bot_added",
  "bot_removed",
  "dialog_cleared",
  "dialog_removed",
  "chat_title_changed",
];

export type MaxTransport = "polling" | "webhook";

/** Explicit `transport` wins; otherwise a configured webhookUrl selects webhook mode. */
export function resolveMaxTransport(config: MaxAccountConfig): MaxTransport {
  if (config.transport === "polling" || config.transport === "webhook") return config.transport;
  return config.webhookUrl?.trim() ? "webhook" : "polling";
}
