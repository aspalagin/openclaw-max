/**
 * Tests for MAX account resolution
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  listMaxAccountIds,
  resolveDefaultMaxAccountId,
  resolveMaxAccount,
} from "./accounts.js";

describe("MAX Account Resolution", () => {
  describe("listMaxAccountIds", () => {
    it("should return empty array when MAX not configured", () => {
      const cfg: OpenClawConfig = { channels: {} };
      const ids = listMaxAccountIds(cfg);
      expect(ids).toEqual([]);
    });

    it("should return default account when top-level token exists", () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            botToken: "test-token",
          },
        },
      };
      const ids = listMaxAccountIds(cfg);
      expect(ids).toContain("default");
    });

    it("should return default account when env token exists", () => {
      const original = process.env.MAX_BOT_TOKEN;
      process.env.MAX_BOT_TOKEN = "env-token";

      const cfg: OpenClawConfig = {
        channels: { max: {} },
      };
      const ids = listMaxAccountIds(cfg);
      expect(ids).toContain("default");

      if (original !== undefined) {
        process.env.MAX_BOT_TOKEN = original;
      } else {
        delete process.env.MAX_BOT_TOKEN;
      }
    });

    it("should list named accounts", () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            accounts: {
              prod: { botToken: "prod-token" },
              dev: { botToken: "dev-token" },
            },
          },
        },
      };
      const ids = listMaxAccountIds(cfg);
      expect(ids).toContain("prod");
      expect(ids).toContain("dev");
    });

    it("should not duplicate default account", () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            botToken: "base-token",
            accounts: {
              default: { botToken: "override" },
            },
          },
        },
      };
      const ids = listMaxAccountIds(cfg);
      const defaultCount = ids.filter((id) => id === "default").length;
      expect(defaultCount).toBe(1);
    });
  });

  describe("resolveDefaultMaxAccountId", () => {
    it("should always return 'default'", () => {
      const cfg: OpenClawConfig = { channels: {} };
      const id = resolveDefaultMaxAccountId(cfg);
      expect(id).toBe("default");
    });
  });

  describe("resolveMaxAccount", () => {
    it("should resolve default account with token from config", () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            enabled: true,
            botToken: "config-token",
            name: "Main Bot",
          },
        },
      };
      const account = resolveMaxAccount({ cfg });
      expect(account.accountId).toBe("default");
      expect(account.token).toBe("config-token");
      expect(account.tokenSource).toBe("config");
      expect(account.enabled).toBe(true);
      expect(account.name).toBe("Main Bot");
    });

    it("should resolve default account with token from env", () => {
      const original = process.env.MAX_BOT_TOKEN;
      process.env.MAX_BOT_TOKEN = "env-token-123";

      const cfg: OpenClawConfig = {
        channels: { max: { enabled: true } },
      };
      const account = resolveMaxAccount({ cfg });
      expect(account.token).toBe("env-token-123");
      expect(account.tokenSource).toBe("env");

      if (original !== undefined) {
        process.env.MAX_BOT_TOKEN = original;
      } else {
        delete process.env.MAX_BOT_TOKEN;
      }
    });

    it("should prefer config token over env", () => {
      const original = process.env.MAX_BOT_TOKEN;
      process.env.MAX_BOT_TOKEN = "env-token";

      const cfg: OpenClawConfig = {
        channels: {
          max: {
            botToken: "config-token",
          },
        },
      };
      const account = resolveMaxAccount({ cfg });
      expect(account.token).toBe("config-token");
      expect(account.tokenSource).toBe("config");

      if (original !== undefined) {
        process.env.MAX_BOT_TOKEN = original;
      } else {
        delete process.env.MAX_BOT_TOKEN;
      }
    });

    it("should resolve named account", () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            accounts: {
              prod: {
                enabled: true,
                botToken: "prod-token",
                name: "Production Bot",
              },
            },
          },
        },
      };
      const account = resolveMaxAccount({ cfg, accountId: "prod" });
      expect(account.accountId).toBe("prod");
      expect(account.token).toBe("prod-token");
      expect(account.name).toBe("Production Bot");
      expect(account.enabled).toBe(true);
    });

    it("should handle account with no token", () => {
      const cfg: OpenClawConfig = {
        channels: { max: {} },
      };
      const account = resolveMaxAccount({ cfg });
      expect(account.token).toBe("");
      expect(account.tokenSource).toBe("none");
    });

    it("should merge config fields for default account", () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            botToken: "token",
            dmPolicy: "allowlist",
            allowFrom: ["user123", 456],
            groups: {
              "chat-1": { requireMention: false },
            },
            groupPolicy: "open",
            webhookUrl: "https://example.com/hook",
            webhookSecret: "secret123",
          },
        },
      };
      const account = resolveMaxAccount({ cfg });
      expect(account.config.dmPolicy).toBe("allowlist");
      expect(account.config.allowFrom).toEqual(["user123", 456]);
      expect(account.config.groups).toHaveProperty("chat-1");
      expect(account.config.groupPolicy).toBe("open");
      expect(account.config.webhookUrl).toBe("https://example.com/hook");
      expect(account.config.webhookSecret).toBe("secret123");
    });

    it("should default enabled to true", () => {
      const cfg: OpenClawConfig = {
        channels: { max: { botToken: "token" } },
      };
      const account = resolveMaxAccount({ cfg });
      expect(account.enabled).toBe(true);
    });

    it("should respect enabled=false", () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            enabled: false,
            botToken: "token",
          },
        },
      };
      const account = resolveMaxAccount({ cfg });
      expect(account.enabled).toBe(false);
    });

    it("should normalize accountId", () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            accounts: {
              prod: { botToken: "token" },
            },
          },
        },
      };
      // normalizeAccountId("  PROD  ") → "prod"
      const account = resolveMaxAccount({ cfg, accountId: "  PROD  " });
      expect(account.accountId).toBe("prod");
    });
  });
});
