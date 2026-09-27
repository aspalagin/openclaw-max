/**
 * Tests for MAX account resolution
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { describe, expect, it } from 'vitest';

import { listMaxAccountIds, resolveDefaultMaxAccountId, resolveMaxAccount } from './accounts.js';

describe('MAX Account Resolution', () => {
  describe('listMaxAccountIds', () => {
    it('should return empty array when MAX not configured', () => {
      const cfg: OpenClawConfig = { channels: {} };
      const ids = listMaxAccountIds(cfg);
      expect(ids).toEqual([]);
    });

    it('should return default account when top-level token exists', () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            botToken: 'test-token',
          },
        },
      };
      const ids = listMaxAccountIds(cfg);
      expect(ids).toContain('default');
    });

    it('should return default account when env token exists', () => {
      const original = process.env.MAX_BOT_TOKEN;
      process.env.MAX_BOT_TOKEN = 'env-token';

      const cfg: OpenClawConfig = {
        channels: { max: {} },
      };
      const ids = listMaxAccountIds(cfg);
      expect(ids).toContain('default');

      if (original !== undefined) {
        process.env.MAX_BOT_TOKEN = original;
      } else {
        delete process.env.MAX_BOT_TOKEN;
      }
    });

    it('should list named accounts', () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            accounts: {
              prod: { botToken: 'prod-token' },
              dev: { botToken: 'dev-token' },
            },
          },
        },
      };
      const ids = listMaxAccountIds(cfg);
      expect(ids).toContain('prod');
      expect(ids).toContain('dev');
    });

    it('should not duplicate default account', () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            botToken: 'base-token',
            accounts: {
              default: { botToken: 'override' },
            },
          },
        },
      };
      const ids = listMaxAccountIds(cfg);
      const defaultCount = ids.filter((id) => id === 'default').length;
      expect(defaultCount).toBe(1);
    });
  });

  describe('resolveDefaultMaxAccountId', () => {
    it("should always return 'default'", () => {
      const cfg: OpenClawConfig = { channels: {} };
      const id = resolveDefaultMaxAccountId(cfg);
      expect(id).toBe('default');
    });
  });

  describe('resolveMaxAccount', () => {
    it('should resolve default account with token from config', () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            enabled: true,
            botToken: 'config-token',
            name: 'Main Bot',
          },
        },
      };
      const account = resolveMaxAccount({ cfg });
      expect(account.accountId).toBe('default');
      expect(account.token).toBe('config-token');
      expect(account.tokenSource).toBe('config');
      expect(account.enabled).toBe(true);
      expect(account.name).toBe('Main Bot');
    });

    it('should resolve default account with token from env', () => {
      const original = process.env.MAX_BOT_TOKEN;
      process.env.MAX_BOT_TOKEN = 'env-token-123';

      const cfg: OpenClawConfig = {
        channels: { max: { enabled: true } },
      };
      const account = resolveMaxAccount({ cfg });
      expect(account.token).toBe('env-token-123');
      expect(account.tokenSource).toBe('env');

      if (original !== undefined) {
        process.env.MAX_BOT_TOKEN = original;
      } else {
        delete process.env.MAX_BOT_TOKEN;
      }
    });

    it('должен читать токен учетной записи из обычного файла', () => {
      const dir = mkdtempSync(join(tmpdir(), 'openclaw-max-token-'));
      const tokenFile = join(dir, 'token');
      writeFileSync(tokenFile, 'file-token-123\n', { mode: 0o600 });

      try {
        const cfg = {
          channels: { max: { enabled: true, tokenFile } },
        } as OpenClawConfig;
        const account = resolveMaxAccount({ cfg });
        expect(account.token).toBe('file-token-123');
        expect(account.tokenSource).toBe('file');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should prefer config token over env', () => {
      const original = process.env.MAX_BOT_TOKEN;
      process.env.MAX_BOT_TOKEN = 'env-token';

      const cfg: OpenClawConfig = {
        channels: {
          max: {
            botToken: 'config-token',
          },
        },
      };
      const account = resolveMaxAccount({ cfg });
      expect(account.token).toBe('config-token');
      expect(account.tokenSource).toBe('config');

      if (original !== undefined) {
        process.env.MAX_BOT_TOKEN = original;
      } else {
        delete process.env.MAX_BOT_TOKEN;
      }
    });

    it('should resolve named account', () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            accounts: {
              prod: {
                enabled: true,
                botToken: 'prod-token',
                name: 'Production Bot',
              },
            },
          },
        },
      };
      const account = resolveMaxAccount({ cfg, accountId: 'prod' });
      expect(account.accountId).toBe('prod');
      expect(account.token).toBe('prod-token');
      expect(account.name).toBe('Production Bot');
      expect(account.enabled).toBe(true);
    });

    it('should handle account with no token', () => {
      const cfg: OpenClawConfig = {
        channels: { max: {} },
      };
      const account = resolveMaxAccount({ cfg });
      expect(account.token).toBe('');
      expect(account.tokenSource).toBe('none');
    });

    it('should merge config fields for default account', () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            botToken: 'token',
            dmPolicy: 'allowlist',
            allowFrom: ['user123', 456],
            groups: {
              'chat-1': { requireMention: false },
            },
            groupPolicy: 'open',
            webhookUrl: 'https://example.com/hook',
            webhookSecret: 'secret123',
          },
        },
      };
      const account = resolveMaxAccount({ cfg });
      expect(account.config.dmPolicy).toBe('allowlist');
      expect(account.config.allowFrom).toEqual(['user123', 456]);
      expect(account.config.groups).toHaveProperty('chat-1');
      expect(account.config.groupPolicy).toBe('open');
      expect(account.config.webhookUrl).toBe('https://example.com/hook');
      expect(account.config.webhookSecret).toBe('secret123');
    });

    it('should default enabled to true', () => {
      const cfg: OpenClawConfig = {
        channels: { max: { botToken: 'token' } },
      };
      const account = resolveMaxAccount({ cfg });
      expect(account.enabled).toBe(true);
    });

    it('should respect enabled=false', () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            enabled: false,
            botToken: 'token',
          },
        },
      };
      const account = resolveMaxAccount({ cfg });
      expect(account.enabled).toBe(false);
    });

    it('should normalize accountId', () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            accounts: {
              prod: { botToken: 'token' },
            },
          },
        },
      };
      // normalizeAccountId("  PROD  ") → "prod"
      const account = resolveMaxAccount({ cfg, accountId: '  PROD  ' });
      expect(account.accountId).toBe('prod');
    });
  });

  describe('named account inheritance', () => {
    const channel = {
      botToken: 'top-token',
      tokenFile: '/nonexistent/top-token',
      name: 'Top bot',
      transport: 'webhook',
      webhookUrl: 'https://hooks.example.test/max',
      webhookSecret: 'top-secret',
      webhookSecretFile: '/nonexistent/top-secret',
      webhookPath: '/max/top',
      commands: [{ name: 'help' }],
      dmPolicy: 'allowlist',
      allowFrom: ['111'],
      groupPolicy: 'open',
      groupAllowFrom: ['222'],
      groups: { '-100': { requireMention: false } },
      mediaMaxMb: 5,
      mediaMaxCount: 3,
      streamMode: 'partial',
      markSeen: false,
      actionScope: 'current',
      notify: false,
      disableLinkPreview: true,
    };

    it('inherits every channel-level option the account does not set', () => {
      const cfg = {
        channels: { max: { ...channel, accounts: { two: { botToken: 'two-token' } } } },
      } as unknown as OpenClawConfig;
      const { config } = resolveMaxAccount({ cfg, accountId: 'two' });
      expect(config).toMatchObject({
        dmPolicy: 'allowlist',
        allowFrom: ['111'],
        groupPolicy: 'open',
        groupAllowFrom: ['222'],
        groups: { '-100': { requireMention: false } },
        mediaMaxMb: 5,
        mediaMaxCount: 3,
        streamMode: 'partial',
        markSeen: false,
        actionScope: 'current',
        notify: false,
        disableLinkPreview: true,
      });
    });

    it('lets an explicit account value win, including false and whole lists', () => {
      const cfg = {
        channels: {
          max: {
            ...channel,
            accounts: {
              two: {
                botToken: 'two-token',
                dmPolicy: 'pairing',
                allowFrom: ['333'],
                groups: { '-200': {} },
                markSeen: true,
                mediaMaxMb: 20,
                actionScope: 'off',
                notify: true,
                disableLinkPreview: false,
              },
            },
          },
        },
      } as unknown as OpenClawConfig;
      const { config } = resolveMaxAccount({ cfg, accountId: 'two' });
      expect(config.dmPolicy).toBe('pairing');
      expect(config.allowFrom).toEqual(['333']);
      expect(config.groups).toEqual({ '-200': {} });
      expect(config.markSeen).toBe(true);
      expect(config.mediaMaxMb).toBe(20);
      expect(config.actionScope).toBe('off');
      expect(config.notify).toBe(true);
      expect(config.disableLinkPreview).toBe(false);
      // not set on the account: still inherited
      expect(config.groupPolicy).toBe('open');
      expect(config.mediaMaxCount).toBe(3);
    });

    it('never inherits the token, its file, the name or the webhook settings', () => {
      const cfg = {
        channels: { max: { ...channel, accounts: { two: {} } } },
      } as unknown as OpenClawConfig;
      const account = resolveMaxAccount({ cfg, accountId: 'two' });
      expect(account.token).toBe('');
      expect(account.tokenSource).toBe('none');
      expect(account.name).toBeUndefined();
      for (const key of [
        'botToken',
        'tokenFile',
        'name',
        'transport',
        'webhookUrl',
        'webhookSecret',
        'webhookSecretFile',
        'webhookPath',
        'commands',
      ]) {
        expect(account.config, key).not.toHaveProperty(key);
      }
    });

    it('keeps the account’s own token and webhook settings', () => {
      const cfg = {
        channels: {
          max: {
            ...channel,
            accounts: {
              two: {
                botToken: 'two-token',
                name: 'Second bot',
                webhookUrl: 'https://hooks.example.test/two',
                webhookSecret: 'two-secret',
              },
            },
          },
        },
      } as unknown as OpenClawConfig;
      const account = resolveMaxAccount({ cfg, accountId: 'two' });
      expect(account.token).toBe('two-token');
      expect(account.name).toBe('Second bot');
      expect(account.config.webhookUrl).toBe('https://hooks.example.test/two');
      expect(account.config.webhookSecret).toBe('two-secret');
      expect(account.config.webhookPath).toBeUndefined();
    });

    it('disables every account when the channel is disabled', () => {
      const cfg = {
        channels: {
          max: { enabled: false, accounts: { two: { botToken: 't' }, three: { enabled: true } } },
        },
      } as unknown as OpenClawConfig;
      expect(resolveMaxAccount({ cfg, accountId: 'two' }).enabled).toBe(false);
      expect(resolveMaxAccount({ cfg, accountId: 'three' }).enabled).toBe(false);
      const on = { channels: { max: { accounts: { two: { enabled: false } } } } };
      expect(resolveMaxAccount({ cfg: on as OpenClawConfig, accountId: 'two' }).enabled).toBe(
        false,
      );
    });

    it('leaves the top-level (default) account unchanged', () => {
      const cfg = {
        channels: { max: { ...channel, accounts: { two: { botToken: 'two-token' } } } },
      } as unknown as OpenClawConfig;
      const account = resolveMaxAccount({ cfg });
      expect(account.token).toBe('top-token');
      expect(account.name).toBe('Top bot');
      expect(account.config.webhookUrl).toBe('https://hooks.example.test/max');
      expect(account.config.notify).toBe(false);
      expect(account.config).not.toHaveProperty('accounts');
    });
  });
});
