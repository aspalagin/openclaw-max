/**
 * Tests for the security adapter (security.resolveDmPolicy / collectWarnings).
 * Since OpenClaw 2026.9.7 `security audit` and doctor hand the adapter the
 * read-only `config.inspectAccount` status, which carries no `config`; the
 * adapter must then read the account section from cfg instead of crashing.
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { describe, expect, it } from 'vitest';

import { resolveMaxAccount } from './accounts.js';
import { maxConfigAdapter } from './channel-config.js';
import { maxSecurityAdapter } from './channel-policy.js';

const TOKEN = 'fake-policy-token';

function maxCfg(max: Record<string, unknown>): OpenClawConfig {
  return { channels: { max } } as unknown as OpenClawConfig;
}

type DmPolicyInput = Parameters<NonNullable<typeof maxSecurityAdapter.resolveDmPolicy>>[0];
type WarningsInput = Parameters<NonNullable<typeof maxSecurityAdapter.collectWarnings>>[0];

const dmPolicy = (input: DmPolicyInput) => {
  const result = maxSecurityAdapter.resolveDmPolicy!(input);
  if (!result) throw new Error('resolveDmPolicy returned nothing');
  return result;
};
const warnings = (input: WarningsInput) => maxSecurityAdapter.collectWarnings!(input);

describe('maxSecurityAdapter.resolveDmPolicy', () => {
  it('uses the config of a fully resolved account', () => {
    const cfg = maxCfg({ botToken: TOKEN, dmPolicy: 'allowlist', allowFrom: ['max:1', 2] });
    const account = resolveMaxAccount({ cfg, accountId: 'default' });
    const result = dmPolicy({ cfg, accountId: 'default', account });
    expect(result.policy).toBe('allowlist');
    expect(result.allowFrom).toEqual(['max:1', 2]);
    expect(result.policyPath).toBe('channels.max.dmPolicy');
    expect(result.allowFromPath).toBe('channels.max.');
    expect(result.normalizeEntry?.('MAX:42')).toBe('42');
  });

  it('re-reads the account section from cfg when given the inspectAccount status (no config)', () => {
    const cfg = maxCfg({ botToken: TOKEN, dmPolicy: 'open', allowFrom: ['*'] });
    const inspected = maxConfigAdapter.inspectAccount!(cfg, 'default');
    expect(inspected).not.toHaveProperty('config');
    const result = dmPolicy({ cfg, accountId: 'default', account: inspected as never });
    expect(result.policy).toBe('open');
    expect(result.allowFrom).toEqual(['*']);
    expect(result.policyPath).toBe('channels.max.dmPolicy');
  });

  it('resolves a named account from channels.max.accounts without config on the account object', () => {
    const cfg = maxCfg({
      botToken: TOKEN,
      dmPolicy: 'open',
      accounts: { work: { botToken: `${TOKEN}-work`, dmPolicy: 'allowlist', allowFrom: ['7'] } },
    });
    const inspected = maxConfigAdapter.inspectAccount!(cfg, 'work');
    const result = dmPolicy({ cfg, accountId: 'work', account: inspected as never });
    expect(result.policy).toBe('allowlist');
    expect(result.allowFrom).toEqual(['7']);
    expect(result.policyPath).toBe('channels.max.accounts.work.dmPolicy');
    expect(result.allowFromPath).toBe('channels.max.accounts.work.');
  });

  it('falls back to pairing with an empty allowlist when nothing is configured', () => {
    const cfg = maxCfg({ botToken: TOKEN });
    const result = dmPolicy({
      cfg,
      accountId: 'default',
      account: { accountId: 'default' } as never,
    });
    expect(result.policy).toBe('pairing');
    expect(result.allowFrom).toEqual([]);
  });
});

describe('maxSecurityAdapter.collectWarnings', () => {
  it('warns about an open group policy from the inspectAccount status as well', () => {
    const cfg = maxCfg({ botToken: TOKEN, groupPolicy: 'open' });
    const inspected = maxConfigAdapter.inspectAccount!(cfg, 'default');
    const fromInspect = warnings({ cfg, account: inspected as never });
    const fromResolved = warnings({
      cfg,
      account: resolveMaxAccount({ cfg, accountId: 'default' }),
    });
    expect(fromInspect).toHaveLength(1);
    expect(fromInspect[0]).toContain('groupPolicy="open"');
    expect(fromInspect).toEqual(fromResolved);
  });

  it('stays silent for the default allowlist policy', () => {
    const cfg = maxCfg({ botToken: TOKEN });
    expect(
      warnings({ cfg, account: maxConfigAdapter.inspectAccount!(cfg, 'default') as never }),
    ).toEqual([]);
  });
});
