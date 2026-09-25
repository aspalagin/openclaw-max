/**
 * Tests for MAX config Zod schema
 */

import {
  DmPolicySchema as SdkDmPolicySchema,
  GroupPolicySchema as SdkGroupPolicySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { describe, expect,it } from "vitest";

import {
  DmPolicySchema,
  GroupPolicySchema,
  MaxAccountSchema,
  MaxConfigSchema,
  MaxGroupSchema,
} from "./config-schema.js";

describe("MAX Config Schema", () => {
  describe("MaxGroupSchema", () => {
    it("should accept valid group config", () => {
      const valid = {
        requireMention: true,
        tools: { allow: ["web_search"] },
        skills: ["search", "calendar"],
        enabled: true,
        allowFrom: ["user123", 456],
        systemPrompt: "Custom prompt",
      };
      const result = MaxGroupSchema.parse(valid);
      expect(result).toMatchObject(valid);
    });

    it("should accept partial config", () => {
      const partial = { requireMention: false };
      const result = MaxGroupSchema.parse(partial);
      expect(result.requireMention).toBe(false);
    });

    it("should reject unknown fields (strict mode)", () => {
      const invalid = { requireMention: true, unknownField: "value" };
      expect(() => MaxGroupSchema.parse(invalid)).toThrow();
    });

    it("should accept tools as object", () => {
      const config = {
        tools: { allow: ["web_search"], deny: ["exec"] },
      };
      const result = MaxGroupSchema.parse(config);
      expect(result.tools).toEqual({ allow: ["web_search"], deny: ["exec"] });
    });
  });

  describe("MaxAccountSchema", () => {
    it("should accept valid account config", () => {
      const valid = {
        name: "Test Bot",
        enabled: true,
        botToken: "test-token-123",
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
      };
      const result = MaxAccountSchema.parse(valid);
      expect(result).toMatchObject(valid);
    });

    it("should accept tokenFile instead of botToken", () => {
      const config = {
        enabled: true,
        tokenFile: "/path/to/token.txt",
      };
      const result = MaxAccountSchema.parse(config);
      expect(result.tokenFile).toBe("/path/to/token.txt");
    });

    it("should validate dmPolicy values", () => {
      const validPolicies = [
        { dmPolicy: "open", allowFrom: ["*"] },
        { dmPolicy: "pairing" },
        { dmPolicy: "allowlist" },
        { dmPolicy: "disabled" },
      ];
      for (const config of validPolicies) {
        expect(() => MaxAccountSchema.parse(config)).not.toThrow();
      }
    });

    it("should reject invalid dmPolicy", () => {
      const invalid = { dmPolicy: "invalid-policy" };
      expect(() => MaxAccountSchema.parse(invalid)).toThrow();
    });

    it("should validate groupPolicy values", () => {
      const validPolicies = ["open", "allowlist", "disabled"];
      for (const policy of validPolicies) {
        const config = { groupPolicy: policy as never };
        expect(() => MaxAccountSchema.parse(config)).not.toThrow();
      }
    });

    it("should require allowFrom with dmPolicy=open", () => {
      const invalid = { dmPolicy: "open", allowFrom: [] };
      expect(() => MaxAccountSchema.parse(invalid)).toThrow(/requires.*allowFrom.*\*/);
    });

    it("should accept dmPolicy=open with wildcard allowFrom", () => {
      const valid = { dmPolicy: "open", allowFrom: ["*"] };
      const result = MaxAccountSchema.parse(valid);
      expect(result.allowFrom).toContain("*");
    });

    it("should accept groups config", () => {
      const config = {
        groups: {
          "chat-123": { requireMention: false },
          "*": { requireMention: true },
        },
      };
      const result = MaxAccountSchema.parse(config);
      expect(result.groups).toHaveProperty("chat-123");
      expect(result.groups).toHaveProperty("*");
    });

    it("should accept webhook config", () => {
      const config = {
        webhookUrl: "https://example.com/webhook",
        webhookSecret: "secret123",
        webhookPath: "/max-webhook",
      };
      const result = MaxAccountSchema.parse(config);
      expect(result.webhookUrl).toBe("https://example.com/webhook");
      expect(result.webhookSecret).toBe("secret123");
      expect(result.webhookPath).toBe("/max-webhook");
    });

    it("should accept transport and webhookSecretFile", () => {
      const result = MaxAccountSchema.parse({
        transport: "webhook",
        webhookUrl: "https://max.example.com/max/webhook",
        webhookSecretFile: "/run/secrets/max-webhook",
      });
      expect(result.transport).toBe("webhook");
      expect(result.webhookSecretFile).toBe("/run/secrets/max-webhook");
      expect(MaxAccountSchema.parse({ transport: "polling" }).transport).toBe("polling");
    });

    it("should reject an unknown transport", () => {
      expect(() => MaxAccountSchema.parse({ transport: "websocket" })).toThrow();
    });

    it("should require webhookUrl for transport=webhook", () => {
      expect(() => MaxAccountSchema.parse({ transport: "webhook" })).toThrow(/requires channels.max.webhookUrl/);
      expect(() => MaxConfigSchema.parse({ transport: "webhook" })).toThrow(/requires channels.max.webhookUrl/);
      expect(() => MaxConfigSchema.parse({
        accounts: { work: { transport: "webhook" } },
      })).toThrow(/requires channels.max.webhookUrl/);
    });

    it("should accept history limits", () => {
      const config = {
        historyLimit: 100,
        dmHistoryLimit: 50,
      };
      const result = MaxAccountSchema.parse(config);
      expect(result.historyLimit).toBe(100);
      expect(result.dmHistoryLimit).toBe(50);
    });

    it("should reject negative history limits", () => {
      const invalid = { historyLimit: -1 };
      expect(() => MaxAccountSchema.parse(invalid)).toThrow();
    });

    it("should accept textChunkLimit", () => {
      const config = { textChunkLimit: 4000 };
      const result = MaxAccountSchema.parse(config);
      expect(result.textChunkLimit).toBe(4000);
    });

    it("should reject non-positive textChunkLimit", () => {
      const invalid = { textChunkLimit: 0 };
      expect(() => MaxAccountSchema.parse(invalid)).toThrow();
    });

    it("should accept blockStreaming config", () => {
      const config = {
        blockStreaming: true,
      };
      const result = MaxAccountSchema.parse(config);
      expect(result.blockStreaming).toBe(true);
    });

    it("should accept mediaMaxMb", () => {
      const config = { mediaMaxMb: 20 };
      const result = MaxAccountSchema.parse(config);
      expect(result.mediaMaxMb).toBe(20);
    });

    it("should reject non-positive mediaMaxMb", () => {
      const invalid = { mediaMaxMb: -5 };
      expect(() => MaxAccountSchema.parse(invalid)).toThrow();
    });

    it("should accept actions config", () => {
      const config = {
        actions: {
          send: true,
          edit: "allowlist",
          delete: false,
        },
      };
      const result = MaxAccountSchema.parse(config);
      expect(result.actions).toMatchObject(config.actions);
    });
  });

  describe("MaxConfigSchema (top-level)", () => {
    it("should accept top-level config with accounts", () => {
      const config = {
        botToken: "default-token",
        dmPolicy: "pairing",
        accounts: {
          prod: {
            botToken: "prod-token",
            name: "Production",
          },
          dev: {
            botToken: "dev-token",
            name: "Development",
          },
        },
      };
      const result = MaxConfigSchema.parse(config);
      expect(result.botToken).toBe("default-token");
      expect(result.accounts).toHaveProperty("prod");
      expect(result.accounts).toHaveProperty("dev");
    });

    it("should validate nested account schemas", () => {
      const invalid = {
        accounts: {
          prod: {
            dmPolicy: "open",
            allowFrom: [], // Missing wildcard
          },
        },
      };
      expect(() => MaxConfigSchema.parse(invalid)).toThrow();
    });

    it("should accept markdown config", () => {
      const config = {
        markdown: {
          tables: "code",
        },
      };
      const result = MaxConfigSchema.parse(config);
      expect(result.markdown).toBeDefined();
    });

    it("should accept dms per-user config", () => {
      const config = {
        dms: {
          "user-123": {},
        },
      };
      const result = MaxConfigSchema.parse(config);
      expect(result.dms).toHaveProperty("user-123");
    });

    it("should accept responsePrefix", () => {
      const config = { responsePrefix: "🤖 " };
      const result = MaxConfigSchema.parse(config);
      expect(result.responsePrefix).toBe("🤖 ");
    });

    it("should reject unknown top-level fields", () => {
      const invalid = {
        botToken: "token",
        unknownField: "value",
      };
      expect(() => MaxConfigSchema.parse(invalid)).toThrow();
    });
  });

  describe("policy enums", () => {
    it("mirror the SDK policy values exactly", () => {
      expect([...DmPolicySchema.options].sort()).toEqual([...SdkDmPolicySchema.options].sort());
      expect([...GroupPolicySchema.options].sort()).toEqual([...SdkGroupPolicySchema.options].sort());
    });

    it("default dmPolicy/groupPolicy when omitted", () => {
      const result = MaxAccountSchema.parse({ botToken: "t" });
      expect(result.dmPolicy).toBe("pairing");
      expect(result.groupPolicy).toBe("allowlist");
    });
  });
});

describe("openclaw.plugin.json channel schema", () => {
  it("declares every account field of the zod schema, including transport and webhookSecretFile", async () => {
    const { readFileSync } = await import("node:fs");
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const properties = manifest.channelConfigs.max.schema.definitions.accountConfig.properties;
    expect(properties.transport.enum).toEqual(["polling", "webhook"]);
    expect(properties.webhookSecretFile.type).toBe("string");
    const { MaxAccountSchemaBase } = await import("./config-schema.js");
    expect(Object.keys(properties).sort()).toEqual(Object.keys(MaxAccountSchemaBase.shape).sort());
  });
});
