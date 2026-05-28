/**
 * MAX channel config Zod schema
 */

import {
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ToolPolicySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

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
  if (params.policy !== "open") return;
  const normalized = (params.allowFrom ?? []).map(String);
  if (normalized.includes("*")) return;
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
 * MAX account config (base schema for both top-level and accounts.*)
 */
export const MaxAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    markdown: MarkdownConfigSchema.optional(),
    botToken: z.string().optional(),
    tokenFile: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groups: z.record(z.string(), MaxGroupSchema.optional()).optional(),
    webhookUrl: z.string().optional(),
    webhookSecret: z.string().optional(),
    webhookPath: z.string().optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    blockStreaming: z.boolean().optional(),
    streamMode: z.enum(["off", "partial", "block"]).optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    responsePrefix: z.string().optional(),
    mediaMaxMb: z.number().positive().optional(),
    actions: z
      .record(
        z.string(),
        z.union([z.boolean(), z.enum(["pairing", "allowlist", "open"])]).optional(),
      )
      .optional(),
  })
  .strict();

/**
 * Individual account schema (with open-policy validation)
 */
export const MaxAccountSchema = MaxAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.max.dmPolicy="open" requires channels.max.allowFrom to include "*"',
  });
});

/**
 * Top-level MAX config schema (supports accounts.* sub-configs)
 */
export const MaxConfigSchema = MaxAccountSchemaBase.extend({
  accounts: z.record(z.string(), MaxAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.max.dmPolicy="open" requires channels.max.allowFrom to include "*"',
  });
});
