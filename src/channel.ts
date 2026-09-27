/**
 * MAX channel plugin for OpenClaw.
 *
 * Implements the ChannelPlugin interface to integrate MAX messenger. The
 * adapters live next to this file by role: channel-config (accounts, setup),
 * channel-policy (DM/group access, pairing), channel-directory (targets,
 * directory), channel-outbound (delivery), channel-lifecycle (start/stop,
 * status, health), channel-agent-prompt; message tool actions in actions.ts.
 */

import type { ChannelMeta } from 'openclaw/plugin-sdk/channel-contract';
import type { ChannelPlugin } from 'openclaw/plugin-sdk/channel-core';
import { buildChannelConfigSchema } from 'openclaw/plugin-sdk/core';

import type { ResolvedMaxAccount } from './accounts.js';
import { maxMessageActions } from './actions.js';
import { maxAgentPromptAdapter } from './channel-agent-prompt.js';
import { maxConfigAdapter, maxSetupAdapter } from './channel-config.js';
import { maxDirectoryAdapter, maxMessagingAdapter } from './channel-directory.js';
import { maxGatewayAdapter, maxStatusAdapter } from './channel-lifecycle.js';
import { maxOutboundAdapter } from './channel-outbound.js';
import { maxGroupsAdapter, maxPairingAdapter, maxSecurityAdapter } from './channel-policy.js';
import { MaxConfigSchema } from './config-schema.js';
import {
  buildMaxModelBrowseChannelData,
  buildMaxModelsAddProviderChannelData,
  buildMaxModelsListChannelData,
  buildMaxModelsMenuChannelData,
  buildMaxModelsProviderChannelData,
} from './model-buttons.js';
import { maxSetupWizard } from './onboarding.js';
import { sendMaxHeartbeatTyping } from './typing.js';

// ── Meta ──

const maxMeta: ChannelMeta = {
  id: 'max',
  label: 'MAX',
  selectionLabel: 'MAX Messenger',
  docsPath: '/channels/max',
  blurb: 'MAX messenger bot via platform-api2.max.ru. Supports DMs, groups, inline keyboards.',
  order: 50,
  aliases: ['max-messenger'],
};

// ── Channel Plugin ──

export const maxPlugin: ChannelPlugin<ResolvedMaxAccount> = {
  id: 'max',
  meta: maxMeta,
  setupWizard: maxSetupWizard,
  configSchema: buildChannelConfigSchema(
    MaxConfigSchema as unknown as Parameters<typeof buildChannelConfigSchema>[0],
  ),

  capabilities: {
    chatTypes: ['direct', 'group', 'channel'],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: true,
    blockStreaming: false,
    edit: true,
    // DELETE /messages backs the "delete" action; replies use link.type=reply.
    unsend: true,
    reply: true,
    polls: false,
  },

  reload: { configPrefixes: ['channels.max'] },

  commands: {
    nativeCommandsAutoEnabled: true,
    nativeSkillsAutoEnabled: true,
    buildModelsMenuChannelData: buildMaxModelsMenuChannelData,
    buildModelsProviderChannelData: buildMaxModelsProviderChannelData,
    buildModelsAddProviderChannelData: buildMaxModelsAddProviderChannelData,
    buildModelsListChannelData: buildMaxModelsListChannelData,
    buildModelBrowseChannelData: buildMaxModelBrowseChannelData,
  },

  agentPrompt: maxAgentPromptAdapter,
  config: maxConfigAdapter,
  security: maxSecurityAdapter,
  groups: maxGroupsAdapter,
  pairing: maxPairingAdapter,

  threading: {
    resolveReplyToMode: () => 'first',
  },
  messaging: maxMessagingAdapter,
  directory: maxDirectoryAdapter,
  outbound: maxOutboundAdapter,
  setup: maxSetupAdapter,
  status: maxStatusAdapter,
  gateway: maxGatewayAdapter,
  heartbeat: { sendTyping: sendMaxHeartbeatTyping },

  // Message actions (send, edit, delete)
  actions: maxMessageActions,
};
