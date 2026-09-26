/**
 * MAX messenger channel plugin for OpenClaw — full entry.
 *
 * defineChannelPluginEntry registers the channel and stores the plugin runtime
 * (setMaxRuntime) in every registration mode that loads channels; setup-only
 * loads use setup-entry.ts instead.
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { maxPlugin } from "./src/channel.js";
import { setMaxRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "openclaw-max",
  name: "MAX",
  description: "MAX messenger channel plugin (max.ru Bot API)",
  plugin: maxPlugin,
  setRuntime: setMaxRuntime,
});
