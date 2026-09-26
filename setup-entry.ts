/**
 * MAX messenger channel plugin — setup entry. OpenClaw loads it instead of
 * index.ts when the channel is disabled or not configured yet (onboarding,
 * config repair): the channel plugin only, no runtime wiring.
 */

import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { maxPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(maxPlugin);
