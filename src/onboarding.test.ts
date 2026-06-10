/**
 * Tests for MAX onboarding adapter
 */

import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { maxSetupWizard } from "./onboarding.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wizard = maxSetupWizard as any;

describe("MAX Onboarding", () => {
  describe("wizard structure", () => {
    it("should have required fields", () => {
      expect(wizard.channel).toBe("max");
      expect(wizard.dmPolicy).toBeDefined();
      expect(wizard.status).toBeDefined();
    });

    it("should have credentials defined", () => {
      expect(Array.isArray(wizard.credentials)).toBe(true);
      expect(wizard.credentials.length).toBeGreaterThan(0);
    });

    it("should have finalize handler", () => {
      expect(typeof wizard.finalize).toBe("function");
    });
  });

  describe("dmPolicy", () => {
    it("should have correct policy configuration", () => {
      expect(wizard.dmPolicy.label).toBe("MAX");
      expect(wizard.dmPolicy.channel).toBe("max");
      expect(wizard.dmPolicy.policyKey).toBe("channels.max.dmPolicy");
      expect(wizard.dmPolicy.allowFromKey).toBe("channels.max.allowFrom");
    });

    it("should get current policy from config", () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            dmPolicy: "allowlist",
          },
        },
      };
      const current = wizard.dmPolicy.getCurrent(cfg);
      expect(current).toBe("allowlist");
    });

    it("should default to pairing when not set", () => {
      const cfg: OpenClawConfig = { channels: {} };
      const current = wizard.dmPolicy.getCurrent(cfg);
      expect(current).toBe("pairing");
    });

    it("should set policy in config", () => {
      const cfg: OpenClawConfig = { channels: {} };
      const updated = wizard.dmPolicy.setPolicy(cfg, "open");
      expect(updated.channels?.max?.dmPolicy).toBe("open");
    });
  });

  describe("status", () => {
    it("should resolve configured status when token exists", () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            botToken: "test-token",
          },
        },
      };
      const result = wizard.status.resolveConfigured({ cfg });
      expect(result).toBe(true);
    });

    it("should resolve unconfigured status when no token", () => {
      const cfg: OpenClawConfig = { channels: {} };
      const result = wizard.status.resolveConfigured({ cfg });
      expect(result).toBe(false);
    });

    it("should resolve status lines", () => {
      const cfg: OpenClawConfig = { channels: {} };
      const lines = wizard.status.resolveStatusLines({ cfg, configured: false });
      expect(lines[0]).toContain("MAX");
      expect(lines[0]).toContain("needs bot token");
    });
  });
});