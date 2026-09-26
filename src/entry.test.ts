/**
 * Plugin entry points: the full entry registers the MAX channel and stores the
 * runtime; the setup entry exposes the same channel plugin without wiring.
 */

import { describe, expect, it, vi } from "vitest";

import plugin from "../index.js";
import setupEntry from "../setup-entry.js";
import { maxPlugin } from "./channel.js";
import { getMaxRuntime } from "./runtime.js";

function mockApi(registrationMode?: string) {
  return {
    registrationMode,
    runtime: { marker: `runtime-${registrationMode}` },
    registerChannel: vi.fn(),
    registerCli: vi.fn(),
  };
}

describe("plugin entry", () => {
  it("keeps the plugin id and metadata", () => {
    expect(plugin.id).toBe("openclaw-max");
    expect(plugin.name).toBe("MAX");
    expect(typeof plugin.register).toBe("function");
    expect(plugin.configSchema).toBeDefined();
  });

  it("registers the MAX channel and stores the runtime on a full load", () => {
    const api = mockApi("full");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugin.register(api as any);
    expect(api.registerChannel).toHaveBeenCalledOnce();
    expect(api.registerChannel).toHaveBeenCalledWith({ plugin: maxPlugin });
    expect(getMaxRuntime()).toBe(api.runtime);
  });

  it("registers the channel when the host passes no registration mode", () => {
    const api = mockApi(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugin.register(api as any);
    expect(api.registerChannel).toHaveBeenCalledWith({ plugin: maxPlugin });
    expect(getMaxRuntime()).toBe(api.runtime);
  });

  it("registers nothing for cli-metadata loads", () => {
    const api = mockApi("cli-metadata");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugin.register(api as any);
    expect(api.registerChannel).not.toHaveBeenCalled();
  });

  it("setup entry exposes the same channel plugin", () => {
    expect(setupEntry.plugin).toBe(maxPlugin);
    expect(setupEntry.plugin.id).toBe("max");
  });
});
