import type { PluginRuntime } from "openclaw/plugin-sdk/core";

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
