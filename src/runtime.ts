import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";

let runtime: PluginRuntime | null = null;

export function setMaxRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getMaxRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("MAX runtime not initialized");
  }
  return runtime;
}

/**
 * Legacy runtime config API (OpenClaw < 2026.9.3).
 * Since 2026.9.3 `loadConfig`/`writeConfigFile` are removed from PluginRuntime;
 * the runtime exposes `config.current()` and transactional `replaceConfigFile`/`mutateConfigFile`.
 */
type LegacyMaxRuntimeConfigApi = {
  loadConfig?: () => Promise<OpenClawConfig> | OpenClawConfig;
  writeConfigFile?: (cfg: OpenClawConfig) => Promise<unknown> | unknown;
};

/** Read the current config snapshot through the plugin runtime, on any supported OpenClaw version. */
export async function loadMaxConfig(): Promise<OpenClawConfig> {
  const config = getMaxRuntime().config;
  if (typeof config.current === "function") {
    return config.current() as OpenClawConfig;
  }
  const legacy = config as unknown as LegacyMaxRuntimeConfigApi;
  if (typeof legacy.loadConfig === "function") {
    return await legacy.loadConfig();
  }
  throw new Error("MAX runtime config API unavailable: neither config.current() nor config.loadConfig()");
}

/** Persist a full config replacement through the plugin runtime, on any supported OpenClaw version. */
export async function writeMaxConfig(nextConfig: OpenClawConfig): Promise<void> {
  const config = getMaxRuntime().config;
  if (typeof config.replaceConfigFile === "function") {
    await config.replaceConfigFile({ nextConfig, afterWrite: { mode: "auto" } });
    return;
  }
  const legacy = config as unknown as LegacyMaxRuntimeConfigApi;
  if (typeof legacy.writeConfigFile === "function") {
    await legacy.writeConfigFile(nextConfig);
    return;
  }
  throw new Error(
    "MAX runtime config API unavailable: neither config.replaceConfigFile() nor config.writeConfigFile()",
  );
}
