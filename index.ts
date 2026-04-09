import { maxPlugin, setMaxRuntime } from "./src/channel.js";

const plugin = {
  id: "openclaw-max",
  name: "MAX",
  description: "MAX messenger channel plugin (max.ru Bot API)",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {},
  },
  register(api: {
    runtime: unknown;
    registerChannel: (opts: { plugin: unknown }) => void;
    logger: { info: (msg: string) => void; warn?: (msg: string) => void; debug?: (msg: string) => void };
  }) {
    // Always update runtime reference (gateway may pass a fresh one on hot reload)
    setMaxRuntime(api.runtime);

    // Register channel on every register() call.
    // Gateway creates a new plugin registry for each load cycle, so we must
    // re-register in each one. The loader's own dedup prevents double-adds
    // within the same registry.
    api.registerChannel({ plugin: maxPlugin });
  },
};

export default plugin;
