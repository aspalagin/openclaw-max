/**
 * MAX typing indicator ("typing_on") on the SDK typing lifecycle.
 *
 * MAX shows the indicator for a few seconds and has no explicit stop action,
 * so a long turn needs periodic refreshes. The shared SDK keepalive owns the
 * refresh loop, the failure circuit breaker and the safety TTL; core stops it
 * when the run completes, fails or is aborted.
 */

import { createTypingCallbacks } from 'openclaw/plugin-sdk/channel-outbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';

import { resolveMaxAccount } from './accounts.js';
import { MaxApi } from './api.js';
import { resolveMaxTarget } from './send.js';

/** Refresh period: shorter than the indicator lifetime on MAX clients. */
export const MAX_TYPING_KEEPALIVE_MS = 4_000;

/** Deadline for one typing request; a slow one is dropped, not retried. */
const MAX_TYPING_TIMEOUT_MS = 5_000;

/**
 * One typing_on request. Best effort: a single attempt with a short deadline,
 * since a retried indicator could land after the reply it announced. The
 * actions endpoint is not a message send, so the per-chat send limiter does
 * not apply; the keepalive period keeps it far below 2 requests per second.
 */
export async function sendMaxTypingAction(
  api: MaxApi,
  chatId: number,
  signal?: AbortSignal,
): Promise<void> {
  await api.sendAction(chatId, 'typing_on', {
    retryAttempts: 0,
    timeoutMs: MAX_TYPING_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
}

/** Typing callbacks for one inbound turn in `chatId`; failures are only logged. */
export function createMaxTypingCallbacks(params: {
  api: MaxApi;
  chatId: number;
  onError: (err: unknown) => void;
}): ReturnType<typeof createTypingCallbacks> {
  return createTypingCallbacks({
    start: () => sendMaxTypingAction(params.api, params.chatId),
    onStartError: params.onError,
    keepaliveIntervalMs: MAX_TYPING_KEEPALIVE_MS,
  });
}

/**
 * heartbeat.sendTyping / sendTypingGuarded: core wraps them in the same
 * keepalive lifecycle (heartbeat runs; gateway runs and task progress use the
 * guarded variant with a cancellation signal and a send-authorization check). Only chat targets can show typing (the actions endpoint takes
 * a chat id); user:<id> targets and accounts without a token are skipped.
 */
export async function sendMaxHeartbeatTyping(params: {
  cfg: OpenClawConfig;
  to: string;
  accountId?: string | null;
  /** Guarded variant: cancellation of the owning run. */
  signal?: AbortSignal;
  /** Guarded variant: throws when the run may no longer send to the platform. */
  assertPlatformSendAuthorized?: () => void;
}): Promise<void> {
  const account = resolveMaxAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.token) return;
  const api = new MaxApi({ token: account.token });
  const target = await resolveMaxTarget(api, params.to);
  if (!('chat_id' in target) || params.signal?.aborted) return;
  // Recheck right before the physical send: the owner may have ended meanwhile.
  params.assertPlatformSendAuthorized?.();
  await sendMaxTypingAction(api, target.chat_id, params.signal);
}
