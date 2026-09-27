/**
 * MAX channel config Zod schema
 */

import { MarkdownConfigSchema, ToolPolicySchema } from 'openclaw/plugin-sdk/channel-config-schema';
import { z } from 'zod';

// Policy fields are built with this package's own zod: wrapping the SDK's enum
// instances in `.optional().default()` broke as soon as the plugin and the
// gateway resolved different zod copies (4.4 vs 4.6 → "expected nonoptional").
// Values mirror the SDK's DmPolicySchema/GroupPolicySchema.
//
// No field carries a schema default: the gateway writes JSON-schema defaults
// into the runtime config, also under accounts.<id>, and a default there would
// hide the channel-level value a named account inherits. The effective
// defaults (pairing, allowlist, …) are applied where the values are read.
export const DmPolicySchema = z.enum(['pairing', 'allowlist', 'open', 'disabled']);
export const GroupPolicySchema = z.enum(['open', 'disabled', 'allowlist']);

// These schemas were removed from the public plugin-sdk surface in OpenClaw 2026.3.x.
// Inlined here to stay compatible with both old and new runtimes.
const BlockStreamingCoalesceSchema = z
  .object({
    minChars: z.number().int().optional(),
    maxChars: z.number().int().optional(),
    idleMs: z.number().int().optional(),
  })
  .strict();

const DmConfigSchema = z
  .object({
    historyLimit: z.number().int().min(0).optional(),
  })
  .strict();

function requireOpenAllowFrom(params: {
  policy: string | undefined;
  allowFrom: unknown[] | undefined;
  ctx: z.RefinementCtx;
  path: (string | number)[];
  message: string;
}): void {
  if (params.policy !== 'open') return;
  const normalized = (params.allowFrom ?? []).map(String);
  if (normalized.includes('*')) return;
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: params.path,
    message: params.message,
  });
}

/**
 * Per-group config for MAX chats
 */
export const MaxGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema.optional(),
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

/**
 * MAX account config (base schema for both top-level and accounts.*).
 * accounts.<id> inherits every channel-level value it does not set, except
 * the per-bot keys (token, name, webhook; MAX_ACCOUNT_OWN_KEYS in accounts.ts).
 */
export const MaxAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    markdown: MarkdownConfigSchema.optional(),
    botToken: z.string().optional(),
    tokenFile: z.string().optional(),
    /** Default "pairing" (applied where read); named accounts inherit the channel value. */
    dmPolicy: DmPolicySchema.optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    /** Default "allowlist" (applied where read); named accounts inherit the channel value. */
    groupPolicy: GroupPolicySchema.optional(),
    groups: z.record(z.string(), MaxGroupSchema.optional()).optional(),
    /** Update transport; default: "webhook" when webhookUrl is set, otherwise "polling" */
    transport: z.enum(['polling', 'webhook']).optional(),
    webhookUrl: z.string().optional(),
    /** MAX secret: 5–256 of [A-Za-z0-9_-]; checked at start */
    webhookSecret: z.string().optional(),
    /** File holding the webhook secret (regular file, not a symlink) */
    webhookSecretFile: z.string().optional(),
    webhookPath: z.string().optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    blockStreaming: z.boolean().optional(),
    streamMode: z.enum(['off', 'partial', 'block']).optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    responsePrefix: z.string().optional(),
    mediaMaxMb: z.number().positive().optional(),
    /** Most media attachments downloaded per inbound message (default 12); the rest is noted. */
    mediaMaxCount: z.number().int().positive().optional(),
    markSeen: z.boolean().optional(),
    /**
     * Chats message-tool actions may act in: "admitted" (default) — the current
     * chat, owner requests and chats admitted by the DM/group policy;
     * "current" — non-owner turns only in their own chat; "off" — no check.
     */
    actionScope: z.enum(['admitted', 'current', 'off']).optional(),
    /**
     * Send defaults; an explicit value of the call (core `silent`,
     * channelData.max) wins. notify=false sends without push notifications
     * (channels always notify).
     */
    notify: z.boolean().optional(),
    disableLinkPreview: z.boolean().optional(),
    actions: z
      .record(
        z.string(),
        z.union([z.boolean(), z.enum(['pairing', 'allowlist', 'open'])]).optional(),
      )
      .optional(),
  })
  .strict();

function requireWebhookUrl(params: {
  transport: string | undefined;
  webhookUrl: string | undefined;
  ctx: z.RefinementCtx;
}): void {
  if (params.transport !== 'webhook' || params.webhookUrl?.trim()) return;
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['webhookUrl'],
    message: 'channels.max.transport="webhook" requires channels.max.webhookUrl',
  });
}

/**
 * Individual account schema (with open-policy validation)
 */
export const MaxAccountSchema = MaxAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ['allowFrom'],
    message: 'channels.max.dmPolicy="open" requires channels.max.allowFrom to include "*"',
  });
  requireWebhookUrl({ transport: value.transport, webhookUrl: value.webhookUrl, ctx });
});

/** Bot command registered via PATCH /me/commands (name ≤64 chars without slash, description ≤128) */
const MaxBotCommandSchema = z
  .object({
    name: z.string().min(1).max(64),
    description: z.string().max(128).optional(),
  })
  .strict();

/**
 * Top-level MAX config schema (supports accounts.* sub-configs)
 */
export const MaxConfigSchema = MaxAccountSchemaBase.extend({
  accounts: z.record(z.string(), MaxAccountSchema.optional()).optional(),
  commands: z.array(MaxBotCommandSchema).max(32).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ['allowFrom'],
    message: 'channels.max.dmPolicy="open" requires channels.max.allowFrom to include "*"',
  });
  requireWebhookUrl({ transport: value.transport, webhookUrl: value.webhookUrl, ctx });
});
