/**
 * Turn status (streaming.mode "progress"): one MAX message that core's
 * progress compositor keeps up to date while the agent works — status
 * headline, plan, approvals and, with streaming.progress.toolProgress, a
 * rolling tool log — and that is deleted once the final answer landed.
 *
 * Core owns what the status says (createChannelProgressDraftCompositor, the
 * channels.max.streaming.progress settings) and when the preview may go away
 * (createLivePreviewLifecycle: deleted after a delivered final, kept after
 * an error final or a failed delivery). This module is the MAX transport:
 * send once, then edit in place, at most one call per second
 * (createDraftStreamLoop) — half of MAX's two edits per second per chat.
 */

import type { ChannelLogSink } from 'openclaw/plugin-sdk/channel-contract';
import {
  createChannelProgressDraftCompositor,
  createDraftStreamLoop,
  createLivePreviewLifecycle,
} from 'openclaw/plugin-sdk/channel-outbound';

import type { ResolvedMaxAccount } from './accounts.js';
import { deleteMaxMessage, editMaxMessage, resolveMaxSendFlags, sendMaxMessage } from './send.js';

/** One send or edit per second for the status message. */
export const MAX_PROGRESS_THROTTLE_MS = 1000;
/** MAX text limit; the compositor stays far below it (8 lines × 120 chars). */
const MAX_PROGRESS_MAX_CHARS = 4000;

type Compositor = ReturnType<typeof createChannelProgressDraftCompositor>;

/** Progress callbacks of the reply dispatch (GetReplyOptions subset). */
export interface MaxProgressReplyOptions {
  suppressDefaultToolProgressMessages: true;
  preserveProgressCallbackStartOrder: true;
  onVerboseProgressVisibility: (isActive: () => boolean) => void;
  onToolStart: (payload: Parameters<Compositor['pushToolEvent']>[0]) => Promise<boolean>;
  onItemEvent: (payload: Parameters<Compositor['pushItemEvent']>[0]) => Promise<boolean>;
  onPlanUpdate: (payload: {
    phase?: string;
    explanation?: string;
    explanationFormat?: 'plain';
    steps?: Parameters<Compositor['pushPlanProgress']>[0];
  }) => Promise<boolean>;
  onApprovalEvent: (payload: Parameters<Compositor['pushApprovalEvent']>[0]) => Promise<boolean>;
  onAssistantMessageStart: () => boolean;
}

export interface MaxProgressDraft {
  readonly replyOptions: MaxProgressReplyOptions;
  /** Mid of the status message while it is shown. */
  readonly messageId: string | undefined;
  /**
   * Deliver a final answer: status updates stop, `send` delivers it, and the
   * status message is deleted once a non-error final landed. Errors of `send`
   * propagate (the status then stays as the record of the failed turn).
   */
  deliverFinal(params: { isError: boolean; send: () => Promise<void> }): Promise<void>;
  /**
   * End of the turn: stop timers and updates; an unused status message (no
   * final, e.g. NO_REPLY or an answer sent by the message tool) is deleted
   * unless the turn failed.
   */
  close(params?: { failed?: boolean }): Promise<void>;
}

export function createMaxProgressDraft(params: {
  account: ResolvedMaxAccount;
  chatId: string;
  replyToId?: string;
  log?: ChannelLogSink;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): MaxProgressDraft {
  const { account, chatId, log, statusSink } = params;
  let messageId: string | undefined;
  let stopped = false;
  let verboseActive: () => boolean = () => false;

  const sendOrEdit = async (text: string): Promise<boolean> => {
    const body =
      text.length > MAX_PROGRESS_MAX_CHARS ? text.slice(0, MAX_PROGRESS_MAX_CHARS) : text;
    if (!messageId) {
      // No status appears once the final answer is on its way.
      if (lifecycle.finalStarted) return false;
      // Plain text (tool names and paths carry markdown characters); no push
      // notification for a temporary message — the final answer notifies.
      const res = await sendMaxMessage(chatId, body, {
        token: account.token,
        replyToMessageId: params.replyToId,
        ...resolveMaxSendFlags(account.config, { silent: true }),
      });
      messageId = res.messageId || undefined;
      statusSink?.({ lastOutboundAt: Date.now() });
      return Boolean(messageId);
    }
    await editMaxMessage(messageId, body, { token: account.token });
    return true;
  };

  const stopOnError = (err: unknown) => {
    // A failed status never fails the turn: stop updating and keep going.
    stopped = true;
    log?.debug?.(`[${account.accountId}] MAX progress status failed: ${String(err)}`);
  };

  const loop = createDraftStreamLoop<string>({
    throttleMs: MAX_PROGRESS_THROTTLE_MS,
    coalesceInFlight: true,
    isStopped: () => stopped,
    sendOrEditStreamMessage: sendOrEdit,
    onBackgroundFlushError: stopOnError,
  });

  const stopUpdates = async () => {
    stopped = true;
    loop.stop();
    await loop.waitForInFlight().catch(() => undefined);
  };

  const lifecycle = createLivePreviewLifecycle<void, string>({
    draft: {
      flush: () => loop.flush().catch(stopOnError),
      id: () => messageId,
      discardPending: stopUpdates,
      clear: async () => {
        if (!messageId) return true;
        await deleteMaxMessage(messageId, { token: account.token });
        messageId = undefined;
        return true;
      },
    },
    // Like Discord: an error final keeps the status as the record of the turn.
    retainOnError: true,
    cleanupUndelivered: true,
    onFinalStarted: () => {
      compositor.markFinalReplyStarted();
      loop.resetPending();
    },
    onFinalDelivered: () => compositor.markFinalReplyDelivered(),
    onCleanupFailure: (err) => {
      log?.warn(`[${account.accountId}] MAX progress status delete failed: ${String(err)}`);
    },
  });

  const compositor = createChannelProgressDraftCompositor({
    preparedItems: true,
    entry: account.config as Parameters<typeof createChannelProgressDraftCompositor>[0]['entry'],
    mode: 'progress',
    active: true,
    seed: `${account.accountId}:${chatId}`,
    update: async (text, options) => {
      if (stopped) return false;
      loop.update(text);
      if (options.flush) await loop.flush().catch(stopOnError);
      return !stopped;
    },
    // Every line was retracted: remove the message; new progress sends a new one.
    deleteCurrent: async () => {
      loop.resetPending();
      await loop.waitForInFlight().catch(() => undefined);
      const current = messageId;
      if (!current) return;
      messageId = undefined;
      await deleteMaxMessage(current, { token: account.token }).catch((err: unknown) => {
        log?.warn(`[${account.accountId}] MAX progress status delete failed: ${String(err)}`);
      });
    },
  });

  /** Progress may change until the final answer starts; verbose mode owns it otherwise. */
  const canPush = () => !stopped && !lifecycle.finalStarted && !verboseActive();
  const push = async (event: () => Promise<boolean>): Promise<boolean> => {
    if (!canPush()) return false;
    try {
      return await event();
    } catch (err) {
      stopOnError(err);
      return false;
    }
  };

  return {
    get messageId() {
      return messageId;
    },
    replyOptions: {
      suppressDefaultToolProgressMessages: true,
      preserveProgressCallbackStartOrder: true,
      onVerboseProgressVisibility: (isActive) => {
        verboseActive = isActive;
      },
      onToolStart: (payload) => push(() => compositor.pushToolEvent(payload)),
      onItemEvent: (payload) => push(() => compositor.pushItemEvent(payload)),
      onPlanUpdate: (payload) =>
        payload.phase === 'update'
          ? push(() =>
              compositor.pushPlanProgress(payload.steps, {
                explanation: payload.explanation,
                explanationFormat: payload.explanationFormat,
              }),
            )
          : Promise.resolve(false),
      onApprovalEvent: (payload) => push(() => compositor.pushApprovalEvent(payload)),
      onAssistantMessageStart: () => {
        compositor.beginAssistantMessage();
        return false;
      },
    },
    deliverFinal: async ({ isError, send }) => {
      await lifecycle.deliver({
        kind: 'final',
        payload: undefined,
        isError,
        deliverNormally: async () => {
          await send();
          return { visibleReplySent: true };
        },
      });
    },
    close: async (options) => {
      compositor.cancel();
      await lifecycle.cleanup({ failed: options?.failed === true });
      await stopUpdates();
    },
  };
}
