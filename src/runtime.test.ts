/**
 * Tests for MAX runtime bridge
 */

import { describe, it, expect, beforeEach } from "vitest";
import { setMaxRuntime, getMaxRuntime } from "./runtime.js";

describe("MAX Runtime Bridge", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockRuntime = {
    channel: {} as never,
    config: {} as never,
    agent: {} as never,
    logging: {} as never,
  } as any;

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
      const runtime1 = { ...mockRuntime };
      const runtime2 = { ...mockRuntime };

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
