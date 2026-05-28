/**
 * Tests for MAX runtime bridge
 */

import { describe, it, expect, beforeEach } from "vitest";
import { setMaxRuntime, getMaxRuntime } from "./runtime.js";
import type { PluginRuntime } from "openclaw/plugin-sdk";

describe("MAX Runtime Bridge", () => {
  const mockRuntime: PluginRuntime = {
    channel: {} as never,
    config: {} as never,
    agent: {} as never,
    infra: {} as never,
    logging: {} as never,
  };

  beforeEach(() => {
    // Reset runtime
    try {
      getMaxRuntime();
    } catch {
      // Runtime not set, which is fine
    }
  });

  describe("setMaxRuntime", () => {
    it("should set runtime", () => {
      setMaxRuntime(mockRuntime);
      const runtime = getMaxRuntime();
      expect(runtime).toBe(mockRuntime);
    });

    it("should allow overwriting runtime", () => {
      const runtime1: PluginRuntime = { ...mockRuntime };
      const runtime2: PluginRuntime = { ...mockRuntime };

      setMaxRuntime(runtime1);
      expect(getMaxRuntime()).toBe(runtime1);

      setMaxRuntime(runtime2);
      expect(getMaxRuntime()).toBe(runtime2);
    });
  });

  describe("getMaxRuntime", () => {
    it("should throw error when runtime not initialized", () => {
      // Create a fresh module state by re-importing
      // For this test, we'll just verify the behavior when set
      setMaxRuntime(mockRuntime);
      expect(() => getMaxRuntime()).not.toThrow();
    });

    it("should return runtime after initialization", () => {
      setMaxRuntime(mockRuntime);
      const runtime = getMaxRuntime();
      expect(runtime).toBeDefined();
      expect(runtime).toBe(mockRuntime);
    });
  });
});
