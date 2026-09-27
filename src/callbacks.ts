/**
 * Button presses (message_callback): presentation approvals and ask_user
 * answers go to the gateway runtimes; other payloads re-enter the inbound
 * pipeline as a synthesized message.
 */

import { resolveApprovalOverGateway } from 'openclaw/plugin-sdk/approval-gateway-runtime';
import { questionGatewayRuntime } from 'openclaw/plugin-sdk/question-gateway-runtime';

import type { ResolvedMaxAccount } from './accounts.js';
import type { MaxCallback, MaxMessage } from './api.js';
import { decodeMaxCommandMenuPayload } from './command-menu.js';
import { processIncomingMessage } from './inbound.js';
import type { MaxMonitorOptions } from './monitor-types.js';
import { decodeMaxPresentationCallback, type MaxPresentationCallback } from './presentation.js';

/**
 * Synthesize a regular message from a button press. The keyboard's message is
 * a sibling of `callback` in the update; its recipient is the real chat
 * (dialog chat_id ≠ user_id). Only when that message is gone (null) do we fall
 * back to addressing the pressing user.
 * callback_id is not a valid MAX message id, so replies to callback-originated
 * commands must not use it as replyToMessageId.
 * @internal - Exported for testing only
 */
export function buildCallbackMessage(
  callback: MaxCallback,
  message: MaxMessage | null,
  text: string = callback.payload ?? '',
): MaxMessage & { __maxCallback: true } {
  return {
    __maxCallback: true,
    sender: callback.user,
    recipient: message ? message.recipient : { chat_id: callback.user.user_id },
    timestamp: callback.timestamp,
    body: {
      mid: callback.callback_id,
      text,
    },
  };
}

export async function processCallback(
  callback: MaxCallback,
  message: MaxMessage | null,
  userLocale: string | null | undefined,
  opts: MaxMonitorOptions,
): Promise<void> {
  const payload = callback.payload ?? '';
  if (!payload.trim()) return;

  // Presentation buttons carry private envelopes (see presentation.ts).
  // Command buttons carry the command text itself and take the default path;
  // plain channelData.max.buttons payloads keep arriving as message text.
  const presentationCallback = decodeMaxPresentationCallback(payload);
  if (presentationCallback?.kind === 'approval' || presentationCallback?.kind === 'question') {
    await resolveMaxRuntimeControlCallback(presentationCallback, callback, opts);
    return;
  }
  // Command menu choices re-enter as that command's text; inbound checks the
  // sender's command rights and whether core still offers the choice.
  const menuCommand = decodeMaxCommandMenuPayload(payload);
  if (menuCommand) {
    const menuMessage = Object.assign(buildCallbackMessage(callback, message, menuCommand), {
      __maxCommandMenu: true as const,
    });
    await processIncomingMessage(menuMessage, userLocale, opts);
    return;
  }
  // Opaque callback data goes to the agent labelled, never as a slash command.
  const text =
    presentationCallback?.kind === 'callback'
      ? `callback_data: ${presentationCallback.value}`
      : payload;

  await processIncomingMessage(buildCallbackMessage(callback, message, text), userLocale, opts);
}

/**
 * Approvals and ask_user answers are operator actions: only senders listed
 * explicitly in the account's allowFrom may press them (a wildcard is enough
 * for questions, never for approvals).
 */
function isMaxRuntimeControlSender(
  account: ResolvedMaxAccount,
  senderId: string,
  kind: 'approval' | 'question',
): boolean {
  const allowFrom = (account.config.allowFrom ?? []).map((entry) =>
    String(entry).trim().replace(/^max:/i, ''),
  );
  if (allowFrom.includes(senderId)) return true;
  return kind === 'question' && allowFrom.includes('*');
}

async function resolveMaxRuntimeControlCallback(
  action: Extract<MaxPresentationCallback, { kind: 'approval' | 'question' }>,
  callback: MaxCallback,
  opts: MaxMonitorOptions,
): Promise<void> {
  const { account, config, log } = opts;
  const senderId = String(callback.user.user_id);
  let notification: string;

  if (!isMaxRuntimeControlSender(account, senderId, action.kind)) {
    log?.warn(
      `[${account.accountId}] MAX ${action.kind} button pressed by unauthorized sender ${senderId}`,
    );
    notification = 'You are not allowed to answer this.';
  } else {
    try {
      if (action.kind === 'approval') {
        const result = await resolveApprovalOverGateway({
          cfg: config,
          approvalId: action.approvalId,
          approvalKind: action.approvalKind,
          decision: action.decision,
          channel: 'max',
          accountId: account.accountId,
          senderId,
        });
        notification = result.applied
          ? `Decision recorded: ${action.decision}.`
          : 'This approval was already resolved.';
      } else {
        const result = await questionGatewayRuntime.resolveOption({
          cfg: config,
          questionId: action.questionId,
          optionValue: action.optionValue,
          senderId,
          authorize: () => isMaxRuntimeControlSender(account, senderId, 'question'),
        });
        notification =
          result.status === 'answered'
            ? 'Answer recorded.'
            : result.status === 'denied'
              ? 'You are not allowed to answer this.'
              : 'This question is no longer open.';
      }
    } catch (err) {
      log?.error(`[${account.accountId}] MAX ${action.kind} callback failed: ${String(err)}`);
      notification = 'Could not apply this action.';
    }
  }

  try {
    await opts.api.answerCallback(callback.callback_id, { notification });
  } catch (err) {
    log?.debug?.(`[${account.accountId}] MAX callback answer failed: ${String(err)}`);
  }
}
