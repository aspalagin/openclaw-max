/**
 * Tests for read-only account inspection (config.inspectAccount) and the
 * status reason of an account without a token: token source and status,
 * transport mode, no token values, no side effects.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { projectCredentialSnapshotFields } from 'openclaw/plugin-sdk/channel-status';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveMaxAccount } from './accounts.js';
import { maxConfigAdapter } from './channel-config.js';
import { maxStatusAdapter } from './channel-lifecycle.js';
import { DEFAULT_MAX_API_BASE_URL, lookupMaxNetwork } from './network.js';

const TOKEN = 'fake-inspect-token';

function maxCfg(max: Record<string, unknown>): OpenClawConfig {
  return { channels: { max } } as unknown as OpenClawConfig;
}

const inspect = (max: Record<string, unknown>, accountId?: string) =>
  maxConfigAdapter.inspectAccount!(maxCfg(max), accountId) as Record<string, unknown>;

describe('inspectAccount', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports source, status and mode of a plain token without the token', () => {
    const result = inspect({ botToken: TOKEN, name: 'Main' });
    expect(result).toEqual({
      accountId: 'default',
      name: 'Main',
      enabled: true,
      configured: true,
      tokenSource: 'config',
      tokenStatus: 'available',
      mode: 'polling',
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(projectCredentialSnapshotFields(result)).toEqual({
      tokenSource: 'config',
      tokenStatus: 'available',
    });
  });

  it('marks a SecretRef the command path cannot read as configured_unavailable', () => {
    const ref = { source: 'file', provider: 'vault', id: '/max/token' };
    expect(inspect({ botToken: ref })).toMatchObject({
      configured: true,
      tokenSource: 'config',
      tokenStatus: 'configured_unavailable',
    });
    expect(inspect({ botToken: ref }).stateReason).toBeUndefined();
    vi.stubEnv('MAX_INSPECT_REF', TOKEN);
    const envRef = inspect({
      botToken: { source: 'env', provider: 'default', id: 'MAX_INSPECT_REF' },
    });
    expect(envRef).toMatchObject({ tokenStatus: 'available' });
    expect(JSON.stringify(envRef)).not.toContain(TOKEN);
  });

  it('explains a missing token by the option path, never the token file path', () => {
    vi.stubEnv('MAX_BOT_TOKEN', '');
    const dir = mkdtempSync(join(tmpdir(), 'max-inspect-'));
    try {
      const missingFile = join(dir, 'absent-token');
      const result = inspect({
        tokenFile: missingFile,
        webhookUrl: 'https://bot.example.test/max',
      });
      expect(result).toMatchObject({
        configured: false,
        tokenSource: 'none',
        tokenStatus: 'missing',
        mode: 'webhook',
        stateReason: 'channels.max.tokenFile is missing, empty or not a regular file',
      });
      expect(JSON.stringify(result)).not.toContain(dir);

      const file = join(dir, 'token');
      writeFileSync(file, `${TOKEN}\n`);
      expect(inspect({ tokenFile: file })).toMatchObject({
        tokenSource: 'file',
        tokenStatus: 'available',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(inspect({ accounts: { two: {} } }, 'two')).toMatchObject({
      accountId: 'two',
      configured: false,
      stateReason:
        'no bot token: set channels.max.accounts.two.botToken or channels.max.accounts.two.tokenFile',
    });
    expect(inspect({}).stateReason).toBe(
      'no bot token: set channels.max.botToken, channels.max.tokenFile or MAX_BOT_TOKEN',
    );
  });

  it('keeps disabled accounts and does not bind the network (no side effects)', () => {
    expect(
      inspect({ accounts: { off: { enabled: false, botToken: 'tok-off' } } }, 'off'),
    ).toMatchObject({ enabled: false, configured: true });
    inspect({ botToken: 'tok-inspect-only', httpProxy: 'http://proxy.example.test:3128' });
    expect(lookupMaxNetwork('tok-inspect-only')).toEqual({ apiBaseUrl: DEFAULT_MAX_API_BASE_URL });
  });
});

describe('status of an account without a token', () => {
  it('carries the reason into the snapshot and the status issue', async () => {
    vi.stubEnv('MAX_BOT_TOKEN', '');
    try {
      const account = resolveMaxAccount({
        cfg: maxCfg({ accounts: { two: {} } }),
        accountId: 'two',
      });
      const snapshot = await maxStatusAdapter.buildAccountSnapshot!({
        account,
        cfg: {} as never,
      } as never);
      expect(snapshot).toMatchObject({ configured: false, tokenStatus: 'missing' });
      expect(snapshot.stateReason).toContain('channels.max.accounts.two.botToken');
      const issues = maxStatusAdapter.collectStatusIssues!([snapshot]);
      expect(issues[0]?.message).toBe(
        'MAX bot token not configured: no bot token: set channels.max.accounts.two.botToken or channels.max.accounts.two.tokenFile',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
