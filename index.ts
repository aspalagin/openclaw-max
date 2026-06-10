import { setMaxRuntime } from "./src/runtime.js";
import { maxPlugin } from "./src/channel.js";

// Для OpenClaw 2026.5.3 плагин может экспортировать channel напрямую
const plugin = {
  id: "openclaw-max",
  name: "MAX",
  description: "MAX messenger channel plugin (max.ru Bot API)",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {},
  },
  register(api: any) {
    setMaxRuntime(api.runtime);
    api.registerChannel({ plugin: maxPlugin });
  }
};

export default plugin;
