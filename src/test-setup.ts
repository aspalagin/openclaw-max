/**
 * Vitest setup: route MAX HTTP through the (mockable) global fetch and keep
 * all persistent state inside a throwaway temp dir.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type * as SsrfRuntime from 'openclaw/plugin-sdk/ssrf-runtime';
import { beforeEach, vi } from 'vitest';

import { resetMaxSendLimiterForTests, setMaxFetchForTests } from './api.js';
import { resetMaxNetworkBindingsForTests } from './network.js';

process.env.OPENCLAW_STATE_DIR = mkdtempSync(join(tmpdir(), 'openclaw-max-test-'));

// No DNS in unit tests: a hostname that passes the literal SSRF checks
// resolves as public. Tests override this mock for the private-DNS case.
vi.mock('openclaw/plugin-sdk/ssrf-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof SsrfRuntime>()),
  resolvePinnedHostnameWithPolicy: vi.fn(async (hostname: string) => ({
    hostname,
    addresses: ['198.51.100.7'],
  })),
}));
// Tests assert on exact fetch call sequences — retries would consume queued mocks.
// Retry behavior itself is covered by tests that pass retryAttempts explicitly.
process.env.OPENCLAW_MAX_RETRY_ATTEMPTS = '1';

type AnyFetch = (url: string, init?: Record<string, unknown>) => Promise<never>;

beforeEach(() => {
  // Late-bound: tests reassign global.fetch per test case
  setMaxFetchForTests((url, init) => (globalThis.fetch as unknown as AnyFetch)(url, init));
  // The 2 msg/s per-chat budget must not leak waits from one test into the next.
  resetMaxSendLimiterForTests();
  // Account resolution binds apiBaseUrl/httpProxy to tokens; start clean.
  resetMaxNetworkBindingsForTests();
});
