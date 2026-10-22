/**
 * Tests for the token source chosen in setup (`openclaw channels add` and the
 * onboarding wizard): the chosen token, token file or MAX_BOT_TOKEN replaces
 * the account's previous source, so the bot really switches to it.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveMaxAccount } from './accounts.js';
import { maxSetupAdapter } from './channel-config.js';
import { maxSetupWizard } from './onboarding.js';

const OLD_TOKEN = 'old-config-token';
const NEW_TOKEN = 'new-config-token';
const FILE_TOKEN = 'file-token';
const ENV_TOKEN = 'env-token';

let dir: string;
let tokenFile: string;
let oldTokenFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'openclaw-max-setup-'));
  tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, `${FILE_TOKEN}\n`, { mode: 0o600 });
  oldTokenFile = join(dir, 'old-token');
  writeFileSync(oldTokenFile, 'old-file-token\n', { mode: 0o600 });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv('MAX_BOT_TOKEN', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function maxCfg(max: Record<string, unknown>): OpenClawConfig {
  return { channels: { max } } as unknown as OpenClawConfig;
}

function maxSection(cfg: OpenClawConfig): Record<string, unknown> {
  return (cfg.channels as Record<string, Record<string, unknown>>).max;
}

function accountSection(cfg: OpenClawConfig, accountId: string): Record<string, unknown> {
  return (maxSection(cfg).accounts as Record<string, Record<string, unknown>>)[accountId];
}

function tokenOf(cfg: OpenClawConfig, accountId = 'default') {
  const { token, tokenSource } = resolveMaxAccount({ cfg, accountId });
  return { token, tokenSource };
}

const channelsAdd = (
  cfg: OpenClawConfig,
  accountId: string,
  input: { token?: string; tokenFile?: string; useEnv?: boolean },
) => maxSetupAdapter.applyAccountConfig({ cfg, accountId, input });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wizard = maxSetupWizard as any;

describe('openclaw channels add: token source', () => {
  it('default: --token-file replaces botToken', () => {
    const cfg = channelsAdd(
      maxCfg({ botToken: OLD_TOKEN, webhookSecret: 'hook-secret', dmPolicy: 'allowlist' }),
      'default',
      { tokenFile: ` ${tokenFile} ` },
    );

    expect(maxSection(cfg)).toEqual({
      enabled: true,
      tokenFile,
      webhookSecret: 'hook-secret',
      dmPolicy: 'allowlist',
    });
    expect(tokenOf(cfg)).toEqual({ token: FILE_TOKEN, tokenSource: 'file' });
  });

  it('default: --token-file replaces a SecretRef botToken', () => {
    const cfg = channelsAdd(
      maxCfg({ botToken: { source: 'env', provider: 'default', id: 'MAX_OLD_TOKEN' } }),
      'default',
      { tokenFile },
    );

    expect(maxSection(cfg)).not.toHaveProperty('botToken');
    expect(tokenOf(cfg)).toEqual({ token: FILE_TOKEN, tokenSource: 'file' });
  });

  it('default: --token replaces tokenFile', () => {
    const cfg = channelsAdd(maxCfg({ tokenFile: oldTokenFile }), 'default', { token: NEW_TOKEN });

    expect(maxSection(cfg)).toEqual({ enabled: true, botToken: NEW_TOKEN });
    expect(tokenOf(cfg)).toEqual({ token: NEW_TOKEN, tokenSource: 'config' });
  });

  it('default: --use-env drops botToken and tokenFile', () => {
    vi.stubEnv('MAX_BOT_TOKEN', ENV_TOKEN);
    const cfg = channelsAdd(
      maxCfg({ botToken: OLD_TOKEN, tokenFile: oldTokenFile, webhookSecret: 'hook-secret' }),
      'default',
      { useEnv: true },
    );

    expect(maxSection(cfg)).toEqual({ enabled: true, webhookSecret: 'hook-secret' });
    expect(tokenOf(cfg)).toEqual({ token: ENV_TOKEN, tokenSource: 'env' });
  });

  it('named: --token-file replaces the account botToken, other accounts untouched', () => {
    const cfg = channelsAdd(
      maxCfg({
        botToken: OLD_TOKEN,
        accounts: {
          work: { name: 'Work', botToken: 'old-work-token' },
          other: { botToken: 'other-token' },
        },
      }),
      'work',
      { tokenFile },
    );

    expect(accountSection(cfg, 'work')).toEqual({ name: 'Work', enabled: true, tokenFile });
    expect(accountSection(cfg, 'other')).toEqual({ botToken: 'other-token' });
    expect(maxSection(cfg).botToken).toBe(OLD_TOKEN);
    expect(tokenOf(cfg, 'work')).toEqual({ token: FILE_TOKEN, tokenSource: 'file' });
    expect(tokenOf(cfg)).toEqual({ token: OLD_TOKEN, tokenSource: 'config' });
  });

  it('named: --token replaces the account tokenFile', () => {
    const cfg = channelsAdd(maxCfg({ accounts: { work: { tokenFile: oldTokenFile } } }), 'work', {
      token: NEW_TOKEN,
    });

    expect(accountSection(cfg, 'work')).toEqual({ enabled: true, botToken: NEW_TOKEN });
    expect(tokenOf(cfg, 'work')).toEqual({ token: NEW_TOKEN, tokenSource: 'config' });
  });

  it('rejects a blank --token-file', () => {
    expect(
      maxSetupAdapter.validateInput!({
        cfg: maxCfg({}),
        accountId: 'default',
        input: { tokenFile: '   ' },
      }),
    ).toMatch(/--token-file/);
  });
});

describe('onboarding wizard: token source', () => {
  it('token file input replaces botToken', async () => {
    const cfg = await wizard.textInputs[0].applySet({
      cfg: maxCfg({ botToken: OLD_TOKEN, dmPolicy: 'allowlist' }),
      accountId: 'default',
      value: ` ${tokenFile} `,
    });

    expect(maxSection(cfg)).toEqual({ enabled: true, tokenFile, dmPolicy: 'allowlist' });
    expect(tokenOf(cfg)).toEqual({ token: FILE_TOKEN, tokenSource: 'file' });
  });

  it('entered token replaces tokenFile', async () => {
    // The token probe (GET /me) fails offline; setup goes on with a warning.
    global.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const cfg = await wizard.credentials[0].applySet({
      cfg: maxCfg({ tokenFile: oldTokenFile }),
      accountId: 'default',
      credentialValues: {},
      value: NEW_TOKEN,
      resolvedValue: NEW_TOKEN,
    });

    expect(maxSection(cfg)).toEqual({ enabled: true, botToken: NEW_TOKEN });
    expect(tokenOf(cfg)).toEqual({ token: NEW_TOKEN, tokenSource: 'config' });
  });

  it('MAX_BOT_TOKEN (credential step and env shortcut) drops botToken and tokenFile', async () => {
    vi.stubEnv('MAX_BOT_TOKEN', ENV_TOKEN);
    const before = maxCfg({ botToken: OLD_TOKEN, tokenFile: oldTokenFile, dmPolicy: 'open' });

    for (const cfg of [
      await wizard.credentials[0].applyUseEnv({ cfg: before, accountId: 'default' }),
      await wizard.envShortcut.apply({ cfg: before, accountId: 'default' }),
    ]) {
      expect(maxSection(cfg)).toEqual({ enabled: true, dmPolicy: 'open' });
      expect(tokenOf(cfg)).toEqual({ token: ENV_TOKEN, tokenSource: 'env' });
    }
  });

  it('named account: token file input replaces the account botToken', async () => {
    const cfg = await wizard.textInputs[0].applySet({
      cfg: maxCfg({ botToken: OLD_TOKEN, accounts: { work: { botToken: 'old-work-token' } } }),
      accountId: 'work',
      value: tokenFile,
    });

    expect(accountSection(cfg, 'work')).toEqual({ enabled: true, tokenFile });
    expect(maxSection(cfg).botToken).toBe(OLD_TOKEN);
    expect(tokenOf(cfg, 'work')).toEqual({ token: FILE_TOKEN, tokenSource: 'file' });
  });
});
