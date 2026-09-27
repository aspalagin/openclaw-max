/**
 * Tests for the MAX SecretRef contract (registry entries, runtime
 * assignments per account) and for SecretRef options in account resolution:
 * resolved, unresolved (start error with the path, no value, no fallback),
 * read-only env refs, schema and manifest.
 */

import { readFileSync } from 'node:fs';

import type { ResolverContext } from 'openclaw/plugin-sdk/channel-secret-basic-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isMaxAccountConfigured, MaxSecretConfigError, resolveMaxAccount } from './accounts.js';
import { MaxApi } from './api.js';
import { maxPlugin } from './channel.js';
import { maxGatewayAdapter } from './channel-lifecycle.js';
import { MaxConfigSchema } from './config-schema.js';
import { lookupMaxNetwork, MaxNetworkConfigError } from './network.js';
import {
  collectRuntimeConfigAssignments,
  maxChannelSecrets,
  secretTargetRegistryEntries,
} from './secret-contract.js';
import { resolveMaxWebhookSecret } from './webhook-runner.js';

const TOKEN = 'fake-token-for-tests';
const envRef = (id: string) => ({ source: 'env', provider: 'default', id });
const fileRef = (id: string) => ({ source: 'file', provider: 'vault', id });

function maxCfg(max: Record<string, unknown>, extra: Record<string, unknown> = {}): OpenClawConfig {
  return { channels: { max }, ...extra } as unknown as OpenClawConfig;
}

function collect(max: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) {
  const config = { channels: { max } } as unknown as OpenClawConfig;
  const context = {
    sourceConfig: config,
    env,
    cache: {},
    warnings: [],
    warningKeys: new Set<string>(),
    assignments: [],
  } as unknown as ResolverContext;
  collectRuntimeConfigAssignments({ config, defaults: undefined, context });
  const assignments = context.assignments as unknown as Array<{
    path: string;
    ownerId: string;
    apply: (value: unknown) => void;
  }>;
  const warnings = context.warnings as unknown as Array<{ code: string; path: string }>;
  return { config, assignments, warnings };
}

describe('secret target registry', () => {
  it('lists botToken, webhookSecret and httpProxy at the channel level and per account', () => {
    expect(secretTargetRegistryEntries.map((entry) => entry.pathPattern).sort()).toEqual([
      'channels.max.accounts.*.botToken',
      'channels.max.accounts.*.httpProxy',
      'channels.max.accounts.*.webhookSecret',
      'channels.max.botToken',
      'channels.max.httpProxy',
      'channels.max.webhookSecret',
    ]);
    for (const entry of secretTargetRegistryEntries) {
      expect(entry).toMatchObject({ includeInAudit: true, expectedResolvedValue: 'string' });
    }
  });

  it('is the channel secrets adapter and the secret-contract-api.js export', async () => {
    expect(maxPlugin.secrets).toBe(maxChannelSecrets);
    const artifact = await import('../secret-contract-api.js');
    expect(artifact.channelSecrets).toBe(maxChannelSecrets);
    expect(artifact.collectRuntimeConfigAssignments).toBe(collectRuntimeConfigAssignments);
    expect(artifact.secretTargetRegistryEntries).toBe(secretTargetRegistryEntries);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts.build).toContain('dist-ts/secret-contract-api.js');
  });
});

describe('runtime assignments', () => {
  it('assigns the default account token and applies the resolved value to the config', () => {
    const { config, assignments, warnings } = collect({ botToken: envRef('MAX_TOKEN_A') });
    expect(assignments.map((a) => [a.path, a.ownerId])).toEqual([
      ['channels.max.botToken', 'max:default'],
    ]);
    assignments[0]!.apply(TOKEN);
    expect((config.channels as Record<string, Record<string, unknown>>).max!.botToken).toBe(TOKEN);
    expect(warnings).toEqual([]);
  });

  it('gives each named account its own token and webhook secret owner', () => {
    const { assignments } = collect({
      accounts: {
        two: {
          botToken: envRef('MAX_TOKEN_TWO'),
          webhookUrl: 'https://bot.example.test/max',
          webhookSecret: envRef('MAX_HOOK_TWO'),
        },
      },
    });
    expect(assignments.map((a) => [a.path, a.ownerId])).toEqual([
      ['channels.max.accounts.two.botToken', 'max:two'],
      ['channels.max.accounts.two.webhookSecret', 'max:two'],
    ]);
  });

  it('shares a channel-level proxy with the default account and every inheriting account', () => {
    const { assignments } = collect({
      botToken: 'plain',
      httpProxy: fileRef('/max/proxy'),
      accounts: {
        two: { botToken: 'plain-two' },
        three: { botToken: 'plain-three', httpProxy: '' },
        off: { botToken: 'plain-off', enabled: false },
      },
    });
    expect(assignments.map((a) => [a.path, a.ownerId])).toEqual([
      ['channels.max.httpProxy', 'max:default'],
      ['channels.max.httpProxy', 'max:two'],
    ]);
  });

  it('skips refs nobody reads with the standard inactive-surface warning', () => {
    const { assignments, warnings } = collect({
      botToken: 'plain',
      webhookSecret: envRef('MAX_HOOK'),
      accounts: {
        off: { enabled: false, botToken: envRef('MAX_TOKEN_OFF') },
        poll: { botToken: 'plain', transport: 'polling', webhookSecret: envRef('MAX_HOOK_P') },
      },
    });
    expect(assignments).toEqual([]);
    expect(warnings.map((w) => [w.code, w.path])).toEqual([
      ['SECRETS_REF_IGNORED_INACTIVE_SURFACE', 'channels.max.accounts.off.botToken'],
      ['SECRETS_REF_IGNORED_INACTIVE_SURFACE', 'channels.max.webhookSecret'],
      ['SECRETS_REF_IGNORED_INACTIVE_SURFACE', 'channels.max.accounts.poll.webhookSecret'],
    ]);
  });

  it('registers nothing for plain strings and a disabled channel', () => {
    expect(
      collect({ botToken: 'plain', httpProxy: 'http://p.example.test:1' }).assignments,
    ).toEqual([]);
    const disabled = collect({ enabled: false, botToken: envRef('MAX_TOKEN_A') });
    expect(disabled.assignments).toEqual([]);
    expect(disabled.warnings).toHaveLength(1);
  });
});

describe('SecretRef options in account resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('uses values the gateway resolved into the runtime snapshot like plain strings', () => {
    const account = resolveMaxAccount({
      cfg: maxCfg({ botToken: ` ${TOKEN} `, httpProxy: 'http://proxy.example.test:3128' }),
    });
    expect(account).toMatchObject({
      token: TOKEN,
      tokenSource: 'config',
      tokenStatus: 'available',
    });
    expect(account.secretErrors).toBeUndefined();
    expect(lookupMaxNetwork(TOKEN).proxyUrl).toBe('http://proxy.example.test:3128');
  });

  it('reads an allowed env ref outside a gateway snapshot (read-only SDK check)', () => {
    vi.stubEnv('MAX_TEST_TOKEN_REF', TOKEN);
    const account = resolveMaxAccount({ cfg: maxCfg({ botToken: envRef('MAX_TEST_TOKEN_REF') }) });
    expect(account).toMatchObject({
      token: TOKEN,
      tokenSource: 'config',
      tokenStatus: 'available',
    });
  });

  it('reports an unresolved token ref with its path and ref, without falling back', async () => {
    vi.stubEnv('MAX_BOT_TOKEN', 'env-fallback-token');
    const account = resolveMaxAccount({ cfg: maxCfg({ botToken: fileRef('/max/token') }) });
    expect(account).toMatchObject({
      token: '',
      tokenSource: 'config',
      tokenStatus: 'configured_unavailable',
    });
    expect(account.secretErrors?.botToken).toContain('channels.max.botToken');
    expect(account.secretErrors?.botToken).toContain('file:vault:/max/token');
    expect(isMaxAccountConfigured(account)).toBe(true);
    expect(maxPlugin.config.isConfigured!(account, {} as never)).toBe(true);
    const error = await maxGatewayAdapter.startAccount!({ account } as never).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(MaxSecretConfigError);
    expect(String(error)).toContain('channels.max.botToken');
    expect(String(error)).not.toContain('env-fallback-token');
  });

  it('names the account path of an unresolved named-account token', () => {
    const account = resolveMaxAccount({
      cfg: maxCfg({ accounts: { two: { botToken: envRef('MAX_TOKEN_UNSET_TWO') } } }),
      accountId: 'two',
    });
    expect(account.tokenStatus).toBe('configured_unavailable');
    expect(account.secretErrors?.botToken).toContain('channels.max.accounts.two.botToken');
  });

  it('keeps the account off the network when its proxy ref did not resolve', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const account = resolveMaxAccount({
      cfg: maxCfg({ httpProxy: fileRef('/max/proxy'), accounts: { two: { botToken: 'tok-two' } } }),
      accountId: 'two',
    });
    expect(account.secretErrors?.httpProxy).toContain('channels.max.httpProxy');
    const error = await new MaxApi({ token: 'tok-two' }).getMe().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MaxNetworkConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(maxGatewayAdapter.startAccount!({ account } as never)).rejects.toThrow(
      /channels\.max\.httpProxy is a SecretRef \(file:vault:\/max\/proxy\)/,
    );
  });

  it('fails the webhook start on an unresolved webhookSecret instead of generating one', async () => {
    const account = resolveMaxAccount({
      cfg: maxCfg({
        botToken: 'tok-hook',
        webhookUrl: 'https://bot.example.test/max',
        webhookSecret: fileRef('/max/hook'),
        webhookSecretFile: '/nonexistent/secret',
      }),
    });
    await expect(resolveMaxWebhookSecret(account)).rejects.toThrow(
      /channels\.max\.webhookSecret is a SecretRef \(file:vault:\/max\/hook\)/,
    );
    const resolved = resolveMaxAccount({
      cfg: maxCfg({ botToken: 'tok-hook', webhookSecret: 'resolved_secret-1' }),
    });
    expect(await resolveMaxWebhookSecret(resolved)).toBe('resolved_secret-1');
  });
});

describe('schema and manifest', () => {
  it('accepts plain strings and core SecretRefs for the three options, rejects bad refs', () => {
    const refs = {
      botToken: envRef('MAX_BOT_TOKEN'),
      webhookSecret: fileRef('/max/hook'),
      httpProxy: { source: 'exec', provider: 'vault', id: 'max-proxy' },
    };
    expect(MaxConfigSchema.safeParse({ ...refs, accounts: { two: refs } }).success).toBe(true);
    expect(MaxConfigSchema.safeParse({ botToken: 'plain', httpProxy: '' }).success).toBe(true);
    expect(MaxConfigSchema.safeParse({ botToken: { source: 'env', id: 'X' } }).success).toBe(false);
    expect(MaxConfigSchema.safeParse({ botToken: envRef('lowercase') }).success).toBe(false);
  });

  it('declares the SecretRef shape and sensitive hints in openclaw.plugin.json', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'),
    );
    const max = manifest.channelConfigs.max;
    const properties = max.schema.definitions.accountConfig.properties;
    for (const field of ['botToken', 'webhookSecret', 'httpProxy']) {
      const variants = properties[field].anyOf;
      expect(variants[0]).toEqual({ type: 'string' });
      expect(
        variants[1].oneOf.map((v: { properties: { source: { const: string } } }) => {
          return v.properties.source.const;
        }),
      ).toEqual(['env', 'store', 'file', 'exec']);
      expect(max.uiHints[field].sensitive).toBe(true);
      expect(max.uiHints[`accounts.*.${field}`].sensitive).toBe(true);
    }
  });
});
