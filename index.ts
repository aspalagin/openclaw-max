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
    logger: { info: (msg: string) => void; warn?: (msg: string) => void };
  }) {
    setMaxRuntime(api.runtime);
    api.registerChannel({ plugin: maxPlugin });
    api.logger.info("MAX channel plugin registered");
  },
};

export default plugin;
