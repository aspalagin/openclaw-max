/**
 * MAX messenger channel plugin for OpenClaw.
 *
 * Entry point: registers the MAX channel with the OpenClaw plugin system.
 */

import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { maxPlugin } from "./channel.js";
import { setMaxRuntime } from "./runtime.js";

// Re-export webhook handler for OpenClaw HTTP server
export { handleMaxWebhookRequest } from "./webhook.js";

const plugin: {
  id: string;
  name: string;
  description: string;
  configSchema: ReturnType<typeof emptyPluginConfigSchema>;
  register(api: OpenClawPluginApi): void;
} = {
  id: "openclaw-max",
  name: "MAX Messenger",
  description: "MAX messenger channel plugin for OpenClaw",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setMaxRuntime(api.runtime);
    api.registerChannel({ plugin: maxPlugin as ChannelPlugin });
  },
};

export default plugin;
