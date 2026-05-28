/**
 * Tests for MAX onboarding adapter
 */

import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { maxOnboardingAdapter } from "./onboarding.js";

describe("MAX Onboarding Adapter", () => {
  describe("adapter structure", () => {
    it("should have required fields", () => {
      expect(maxOnboardingAdapter.channel).toBe("max");
      expect(maxOnboardingAdapter.dmPolicy).toBeDefined();
      expect(maxOnboardingAdapter.getStatus).toBeDefined();
      expect(maxOnboardingAdapter.configure).toBeDefined();
    });
  });

  describe("getStatus", () => {
    it("should report unconfigured status when no token", async () => {
      const cfg: OpenClawConfig = { channels: {} };
      const status = await maxOnboardingAdapter.getStatus({ cfg });
      expect(status.channel).toBe("max");
      expect(status.configured).toBe(false);
      expect(status.selectionHint).toContain("needs auth");
    });

    it("should report configured status when token exists", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            botToken: "test-token",
          },
        },
      };
      const status = await maxOnboardingAdapter.getStatus({ cfg });
      expect(status.configured).toBe(true);
      expect(status.selectionHint).toBe("configured");
    });

    it("should report configured when env token exists", async () => {
      const original = process.env.MAX_BOT_TOKEN;
      process.env.MAX_BOT_TOKEN = "env-token";

      const cfg: OpenClawConfig = {
        channels: { max: {} },
      };
      const status = await maxOnboardingAdapter.getStatus({ cfg });
      expect(status.configured).toBe(true);

      if (original !== undefined) {
        process.env.MAX_BOT_TOKEN = original;
      } else {
        delete process.env.MAX_BOT_TOKEN;
      }
    });
  });

  describe("dmPolicy", () => {
    it("should have correct policy configuration", () => {
      expect(maxOnboardingAdapter.dmPolicy.label).toBe("MAX");
      expect(maxOnboardingAdapter.dmPolicy.channel).toBe("max");
      expect(maxOnboardingAdapter.dmPolicy.policyKey).toBe("channels.max.dmPolicy");
      expect(maxOnboardingAdapter.dmPolicy.allowFromKey).toBe("channels.max.allowFrom");
    });

    it("should get current policy from config", () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            dmPolicy: "allowlist",
          },
        },
      };
      const current = maxOnboardingAdapter.dmPolicy.getCurrent(cfg);
      expect(current).toBe("allowlist");
    });

    it("should default to pairing when not set", () => {
      const cfg: OpenClawConfig = { channels: {} };
      const current = maxOnboardingAdapter.dmPolicy.getCurrent(cfg);
      expect(current).toBe("pairing");
    });

    it("should set policy in config", () => {
      const cfg: OpenClawConfig = { channels: {} };
      const updated = maxOnboardingAdapter.dmPolicy.setPolicy(cfg, "open");
      expect(updated.channels?.max?.dmPolicy).toBe("open");
      expect(updated.channels?.max?.allowFrom).toContain("*");
    });
  });

  // Full configure() tests would require mock WizardPrompter
  // which is complex to set up. These are better suited for integration tests.
});
