/**
 * Vitest setup: route MAX HTTP through the (mockable) global fetch and keep
 * all persistent state inside a throwaway temp dir.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";

import { setMaxFetchForTests } from "./api.js";

process.env.OPENCLAW_STATE_DIR = mkdtempSync(join(tmpdir(), "openclaw-max-test-"));
// Tests assert on exact fetch call sequences — retries would consume queued mocks.
// Retry behavior itself is covered by tests that pass retryAttempts explicitly.
process.env.OPENCLAW_MAX_RETRY_ATTEMPTS = "1";

type AnyFetch = (url: string, init?: Record<string, unknown>) => Promise<never>;

beforeEach(() => {
  // Late-bound: tests reassign global.fetch per test case
  setMaxFetchForTests((url, init) => (globalThis.fetch as unknown as AnyFetch)(url, init));
});
