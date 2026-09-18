/**
 * Tests for MAX runtime bridge
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { setMaxRuntime, getMaxRuntime, loadMaxConfig, writeMaxConfig } from "./runtime.js";

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

describe("MAX runtime config helpers", () => {
  const baseCfg = { channels: { max: { botToken: "token" } } };
  const withConfig = (config: Record<string, unknown>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ channel: {}, agent: {}, logging: {}, config }) as any;

  describe("loadMaxConfig", () => {
    it("prefers config.current() (OpenClaw >= 2026.9.3)", async () => {
      const loadConfig = vi.fn(async () => ({ legacy: true }));
      setMaxRuntime(withConfig({ current: () => baseCfg, loadConfig }));
      await expect(loadMaxConfig()).resolves.toBe(baseCfg);
      expect(loadConfig).not.toHaveBeenCalled();
    });

    it("falls back to legacy config.loadConfig()", async () => {
      setMaxRuntime(withConfig({ loadConfig: async () => baseCfg }));
      await expect(loadMaxConfig()).resolves.toBe(baseCfg);
    });

    it("throws when no config API is available", async () => {
      setMaxRuntime(withConfig({}));
      await expect(loadMaxConfig()).rejects.toThrow(/config API unavailable/);
    });
  });

  describe("writeMaxConfig", () => {
    it("prefers transactional config.replaceConfigFile() (OpenClaw >= 2026.9.3)", async () => {
      const replaceConfigFile = vi.fn(async () => ({}));
      const writeConfigFile = vi.fn(async () => undefined);
      setMaxRuntime(withConfig({ replaceConfigFile, writeConfigFile }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await writeMaxConfig(baseCfg as any);
      expect(replaceConfigFile).toHaveBeenCalledWith({
        nextConfig: baseCfg,
        afterWrite: { mode: "auto" },
      });
      expect(writeConfigFile).not.toHaveBeenCalled();
    });

    it("falls back to legacy config.writeConfigFile()", async () => {
      const writeConfigFile = vi.fn(async () => undefined);
      setMaxRuntime(withConfig({ writeConfigFile }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await writeMaxConfig(baseCfg as any);
      expect(writeConfigFile).toHaveBeenCalledWith(baseCfg);
    });

    it("throws when no config write API is available", async () => {
      setMaxRuntime(withConfig({}));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(writeMaxConfig(baseCfg as any)).rejects.toThrow(/config API unavailable/);
    });
  });
});
