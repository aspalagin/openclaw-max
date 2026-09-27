/**
 * Update dispatch: routes each MAX update by update_type — messages and edits
 * to the inbound pipeline, button presses to callbacks, bot/dialog lifecycle
 * events to the chat registry.
 */

import type { ResolvedMaxAccount } from './accounts.js';
import type { MaxMessage, MaxUpdate, MaxUser } from './api.js';
import { processCallback } from './callbacks.js';
import { processIncomingMessage } from './inbound.js';
import type { MaxMonitorOptions } from './monitor-types.js';

/** mark_seen vanished from current MAX docs; keep behind config (default on). */
function shouldMarkSeen(account: ResolvedMaxAccount): boolean {
  return account.config.markSeen !== false;
}

function sendReadReceipt(chatId: number | undefined, opts: MaxMonitorOptions): void {
  const { log, account } = opts;
  if (!chatId) return;
  if (shouldMarkSeen(account)) {
    opts.api.sendAction(chatId, 'mark_seen').catch((err) => {
      log?.debug?.(`[${account.accountId}] mark_seen failed: ${String(err)}`);
    });
  }
  // typing_on is kept up by processIncomingMessage for the agent turn — only
  // for messages that pass the group/DM gates.
}

/** Route one update by update_type (shared by the polling loop and the webhook queue). */
export async function dispatchUpdate(update: MaxUpdate, opts: MaxMonitorOptions): Promise<void> {
  const { log, account, statusSink } = opts;

  switch (update.update_type) {
    case 'message_created': {
      if (!update.message) break;
      // Skip messages from the bot itself
      if (opts.botUserId && update.message.sender?.user_id === opts.botUserId) break;
      statusSink?.({ lastInboundAt: Date.now() });
      // Mark message as read (typing starts once the message reaches the agent)
      sendReadReceipt(update.message.recipient?.chat_id, opts);
      // Passive chat discovery: GET /chats is deprecated, register group chats
      // the bot actually sees so directory.listGroups keeps working.
      const recipient = update.message.recipient;
      if (
        opts.state &&
        recipient?.chat_id != null &&
        (recipient.chat_type === 'chat' || recipient.chat_type === 'channel') &&
        !opts.state.hasActiveChat(recipient.chat_id)
      ) {
        // A message from this chat proves the bot is a member — (re)register it,
        // clearing any stale removedAt from an earlier bot_removed/dialog_removed.
        opts.state.upsertChat(recipient.chat_id, {
          type: recipient.chat_type,
          addedAt: Date.now(),
        });
      }
      await processIncomingMessage(update.message, update.user_locale, opts);
      break;
    }

    case 'message_callback': {
      if (!update.callback) break;
      statusSink?.({ lastInboundAt: Date.now() });
      await processCallback(update.callback, update.message ?? null, update.user_locale, opts);
      break;
    }

    case 'message_edited': {
      // An edit always carries the edited body; a forward-only message
      // (body null) cannot be edited.
      if (!update.message?.body) break;
      // Skip edits from the bot itself
      if (opts.botUserId && update.message.sender?.user_id === opts.botUserId) break;
      log?.debug?.(
        `[${account.accountId}] Message edited: ${update.message?.body?.mid} text="${update.message?.body?.text ?? '<null>'}" hasBody=${!!update.message?.body}`,
      );
      statusSink?.({ lastInboundAt: Date.now() });
      // Mark as read (typing starts once the message reaches the agent)
      sendReadReceipt(update.message.recipient?.chat_id, opts);
      // Process edited message through the same pipeline as new messages.
      // Use a unique mid suffix to avoid OpenClaw dedup (same mid = skipped).
      const originalMid = update.message.body.mid;
      const editedMessage = {
        ...update.message,
        body: { ...update.message.body, mid: `${originalMid}_edited_${update.timestamp}` },
      };

      // MAX message_edited may not include text — fetch it from API if missing
      if (!editedMessage.body.text?.trim() && originalMid) {
        try {
          const chatId = editedMessage.recipient?.chat_id;
          if (chatId) {
            const fetched = await opts.api.getMessages(chatId, {
              message_ids: [originalMid],
              count: 1,
            });
            const fetchedMsg = fetched.messages?.[0];
            if (fetchedMsg?.body?.text) {
              editedMessage.body = { ...editedMessage.body, text: fetchedMsg.body.text };
              if (fetchedMsg.body.attachments?.length) {
                editedMessage.body.attachments = fetchedMsg.body.attachments;
              }
              log?.debug?.(
                `[${account.accountId}] Fetched edited text: "${fetchedMsg.body.text.slice(0, 50)}"`,
              );
            }
          }
        } catch (err) {
          log?.debug?.(
            `[${account.accountId}] Failed to fetch edited message text: ${String(err)}`,
          );
        }
      }

      await processIncomingMessage(editedMessage, update.user_locale, opts);
      break;
    }

    case 'bot_started': {
      if (!update.user) break;
      log?.info(
        `[${account.accountId}] Bot started by user ${update.user.user_id}${update.payload ? ' (with deeplink payload)' : ''}`,
      );
      statusSink?.({ lastInboundAt: Date.now() });
      if (opts.state && update.chat_id != null) {
        opts.state.upsertChat(update.chat_id, {
          type: 'dialog',
          addedAt: Date.now(),
          stopped: false,
        });
      }
      await processBotStarted(update.user, update.chat_id, update.payload ?? undefined, opts);
      break;
    }

    case 'bot_stopped': {
      // User halted the bot in a dialog — stop proactive sends until they return
      log?.info(
        `[${account.accountId}] Bot stopped by user ${update.user?.user_id ?? '?'} (chat ${update.chat_id ?? '?'})`,
      );
      if (opts.state && update.chat_id != null) {
        opts.state.upsertChat(update.chat_id, { type: 'dialog', stopped: true });
      }
      break;
    }

    case 'bot_added': {
      log?.info(`[${account.accountId}] Bot added to chat ${update.chat_id}`);
      if (opts.state && update.chat_id != null) {
        opts.state.upsertChat(update.chat_id, {
          type: update.is_channel ? 'channel' : 'chat',
          addedAt: Date.now(),
        });
      }
      break;
    }

    case 'bot_removed': {
      log?.info(`[${account.accountId}] Bot removed from chat ${update.chat_id}`);
      if (opts.state && update.chat_id != null) {
        opts.state.upsertChat(update.chat_id, { removedAt: Date.now() });
      }
      break;
    }

    case 'dialog_removed': {
      log?.info(
        `[${account.accountId}] Dialog removed by user ${update.user_id ?? update.user?.user_id ?? '?'} (chat ${update.chat_id ?? '?'})`,
      );
      if (opts.state && update.chat_id != null) {
        opts.state.upsertChat(update.chat_id, { removedAt: Date.now() });
      }
      break;
    }

    case 'dialog_cleared': {
      // User wiped the dialog history on their side; keep our session but log it
      log?.info(
        `[${account.accountId}] Dialog cleared by user ${update.user_id ?? update.user?.user_id ?? '?'} (chat ${update.chat_id ?? '?'})`,
      );
      break;
    }

    case 'chat_title_changed': {
      if (opts.state && update.chat_id != null && typeof update.title === 'string') {
        opts.state.upsertChat(update.chat_id, { title: update.title });
      }
      break;
    }

    case 'message_removed': {
      // Deliberate no-op: OpenClaw sessions have no per-message retraction.
      log?.debug?.(
        `[${account.accountId}] Message removed in chat ${update.chat_id ?? '?'}: ${(update as { message_id?: string }).message_id ?? '?'}`,
      );
      break;
    }

    default:
      log?.debug?.(`[${account.accountId}] Unhandled update type: ${update.update_type}`);
  }
}

async function processBotStarted(
  user: MaxUser,
  chatId: number | undefined,
  payload: string | undefined,
  opts: MaxMonitorOptions,
): Promise<void> {
  // Synthesize a /start message; deeplink payload (max.ru/<bot>?start=...) is
  // forwarded as the command argument like other messengers do.
  const startText = payload?.trim() ? `/start ${payload.trim()}` : '/start';
  const syntheticMessage: MaxMessage = {
    sender: user,
    recipient: { chat_id: chatId ?? user.user_id, chat_type: 'dialog' },
    timestamp: Date.now(),
    body: {
      mid: `bot_started_${user.user_id}_${Date.now()}`,
      text: startText,
    },
  };

  await processIncomingMessage(syntheticMessage, null, opts);
}
