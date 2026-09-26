/**
 * Edit streaming (streamMode "partial"): the first partial reply is sent as a
 * message, later partials edit it (throttled), and the final answer replaces
 * the draft together with its inline keyboard. The draft holds one MAX
 * message: a longer final answer is split by the reply delivery, which puts
 * the first chunk into the draft and sends the rest as new messages.
 */

import type { ChannelLogSink } from 'openclaw/plugin-sdk/channel-contract';

import type { ResolvedMaxAccount } from './accounts.js';
import { deleteMaxMessage, editMaxMessage, type MaxSendButton, sendMaxMessage } from './send.js';

const DRAFT_THROTTLE_MS = 1200;
const DRAFT_MAX_CHARS = 4000;
const DRAFT_MIN_CHARS = 30; // Don't send until we have enough text

export interface MaxDraftStream {
  /** Mid of the draft message once the first partial was sent. */
  readonly messageId: string | null;
  /** Show a partial reply (throttled; stops on errors or past 4000 chars). */
  update(text: string): Promise<void>;
  /**
   * Replace the draft with the final text (at most one MAX message); buttons
   * go onto the same edit. Resolves false when MAX refused the edit.
   */
  finalize(text: string, buttons: MaxSendButton[][] | undefined): Promise<boolean>;
  /** Delete the draft (its final edit was refused); resolves false when that fails too. */
  discard(): Promise<boolean>;
  /** Cancel a pending update and stop streaming. */
  clear(): Promise<void>;
}

/** Draft stream for edit-streaming (like Telegram's partial reply approach). */
export function createMaxDraftStream(params: {
  account: ResolvedMaxAccount;
  chatId: string;
  replyToId?: string;
  log?: ChannelLogSink;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): MaxDraftStream {
  const { account, chatId, log, statusSink } = params;
  let draftMid: string | null = null;
  let draftLastText = '';
  let draftLastEditAt = 0;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let draftStopped = false;

  const draftUpdate = async (text: string) => {
    if (draftStopped || !text) return;
    const trimmed = text.trimEnd();
    if (!trimmed || trimmed === draftLastText) return;
    if (trimmed.length > DRAFT_MAX_CHARS) {
      draftStopped = true;
      return;
    }
    if (!draftMid && trimmed.length < DRAFT_MIN_CHARS) return; // wait for more text

    // Clear pending timer
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }

    const now = Date.now();
    const elapsed = now - draftLastEditAt;
    if (elapsed < DRAFT_THROTTLE_MS) {
      // Schedule a deferred update
      draftTimer = setTimeout(() => {
        draftUpdate(text);
      }, DRAFT_THROTTLE_MS - elapsed);
      return;
    }

    draftLastText = trimmed;
    draftLastEditAt = now;

    try {
      if (!draftMid) {
        // First chunk — send new message
        const res = await sendMaxMessage(chatId, trimmed, {
          token: account.token,
          replyToMessageId: params.replyToId,
          format: 'markdown',
        });
        draftMid = res.messageId || null;
        statusSink?.({ lastOutboundAt: Date.now() });
      } else {
        // Edit existing message
        await editMaxMessage(draftMid, trimmed, {
          token: account.token,
          format: 'markdown',
        });
      }
    } catch (err) {
      draftStopped = true;
      log?.debug?.(`[${account.accountId}] MAX draft stream failed: ${String(err)}`);
    }
  };

  return {
    get messageId() {
      return draftMid;
    },
    update: draftUpdate,
    finalize: async (finalText, buttons) => {
      // Final delivery replaces the draft message with final text. The
      // keyboard (presentation buttons) goes onto the same edit, otherwise
      // the final answer would lose its buttons.
      if (draftTimer) {
        clearTimeout(draftTimer);
        draftTimer = null;
      }
      draftStopped = true;
      if (!draftMid) return false;
      if (finalText === draftLastText && !buttons?.length) return true;
      try {
        await editMaxMessage(draftMid, finalText, {
          token: account.token,
          format: 'markdown',
          buttons,
        });
        draftLastText = finalText;
        return true;
      } catch (err) {
        log?.warn(`[${account.accountId}] MAX draft final edit failed: ${String(err)}`);
        return false;
      }
    },
    discard: async () => {
      if (!draftMid) return true;
      try {
        await deleteMaxMessage(draftMid, { token: account.token });
        draftMid = null;
        return true;
      } catch (err) {
        log?.warn(`[${account.accountId}] MAX draft delete failed: ${String(err)}`);
        return false;
      }
    },
    clear: async () => {
      if (draftTimer) {
        clearTimeout(draftTimer);
        draftTimer = null;
      }
      draftStopped = true;
    },
  };
}
