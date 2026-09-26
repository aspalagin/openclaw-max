/**
 * MAX monitor — receives updates (long polling or webhook) and dispatches them
 * to OpenClaw.
 *
 * Uses the same inbound pipeline as other channel plugins:
 * finalizeInboundContext → dispatchReplyWithBufferedBlockDispatcher
 *
 * Roles: polling.ts / webhook-runner.ts (transports) → dispatch.ts (by
 * update_type) → inbound.ts (gates, context, agent run; attachments in
 * inbound-attachments.ts) / callbacks.ts (button presses) → deliver.ts and
 * stream-draft.ts (replies).
 */

import { type MaxMonitorOptions, resolveMaxTransport } from './monitor-types.js';
import { clearMaxSubscriptionsForPolling, startMaxPollingLoop } from './polling.js';
import { MaxStateStore } from './state.js';
import { startMaxWebhook } from './webhook-runner.js';

export {
  MAX_SUBSCRIBED_UPDATE_TYPES,
  type MaxMonitorOptions,
  type MaxStatusPatch,
  type MaxTransport,
  resolveMaxTransport,
} from './monitor-types.js';

export async function startMaxPolling(opts: MaxMonitorOptions): Promise<void> {
  const { account, log } = opts;

  // Persistent state: polling marker + chat registry + webhook secret
  if (!opts.state) {
    opts.state = new MaxStateStore(account.accountId, (err) => {
      log?.error(`[${account.accountId}] MAX state persist failed: ${String(err)}`);
    });
  }
  try {
    await opts.state.load();
  } catch (err) {
    log?.error(`[${account.accountId}] MAX state load failed: ${String(err)}`);
  }

  if (resolveMaxTransport(account.config) === 'webhook') {
    await startMaxWebhook(opts);
  } else {
    // An active subscription silently disables long polling on the MAX side.
    await clearMaxSubscriptionsForPolling(opts);
    await startMaxPollingLoop(opts);
  }
}
