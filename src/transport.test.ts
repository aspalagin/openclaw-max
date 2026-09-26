/**
 * Tests for the MAX update transport: polling vs webhook mode, the gateway
 * route and the subscription lifecycle (mock MaxApi, no network).
 */

import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChannelLogSink } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MaxAccountConfig, ResolvedMaxAccount } from "./accounts.js";
import type { MaxApi } from "./api.js";
import {
  MAX_SUBSCRIBED_UPDATE_TYPES,
  type MaxStatusPatch,
  resolveMaxTransport,
  startMaxPolling,
} from "./monitor.js";
import { clearMaxSubscriptionsForPolling } from "./polling.js";
import { MaxStateStore } from "./state.js";
import { handleMaxWebhookRequest } from "./webhook.js";
import {
  MAX_SUBSCRIPTION_CHECK_INTERVAL_MS,
  resolveMaxWebhookSecret,
  startMaxSubscriptionWatch,
} from "./webhook-runner.js";

function account(config: MaxAccountConfig, accountId = "default"): ResolvedMaxAccount {
  return { accountId, enabled: true, token: "t", tokenSource: "config", config };
}

function mockLog() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return log as typeof log & ChannelLogSink;
}

function mockApi(subscriptions: Array<{ url: string; time: number }>) {
  return {
    getSubscriptions: vi.fn().mockResolvedValue({ subscriptions }),
    subscribe: vi.fn().mockResolvedValue({ success: true }),
    unsubscribe: vi.fn().mockResolvedValue({ success: true }),
    getUpdates: vi.fn(),
  };
}

/** Wait until the monitor reaches its steady state, then stop it. */
async function runUntil(
  start: Promise<void>,
  controller: AbortController,
  ready: () => void,
): Promise<void> {
  await vi.waitFor(ready);
  controller.abort();
  await start;
}

describe("resolveMaxTransport", () => {
  it("defaults to webhook only when webhookUrl is set", () => {
    expect(resolveMaxTransport({})).toBe("polling");
    expect(resolveMaxTransport({ webhookUrl: "https://max.example/max/webhook" })).toBe("webhook");
  });

  it("lets an explicit transport win", () => {
    expect(resolveMaxTransport({ transport: "polling", webhookUrl: "https://x/y" })).toBe("polling");
    expect(resolveMaxTransport({ transport: "webhook" })).toBe("webhook");
  });
});

describe("resolveMaxWebhookSecret", () => {
  it("prefers webhookSecret, then webhookSecretFile", async () => {
    expect(await resolveMaxWebhookSecret(account({ webhookSecret: " abc_DEF-123 " }))).toBe("abc_DEF-123");

    const dir = mkdtempSync(join(tmpdir(), "max-secret-"));
    const file = join(dir, "secret");
    writeFileSync(file, "from-file-secret\n");
    expect(await resolveMaxWebhookSecret(account({ webhookSecretFile: file }))).toBe("from-file-secret");
  });

  it("rejects an unreadable secret file and a symlink", async () => {
    const dir = mkdtempSync(join(tmpdir(), "max-secret-"));
    await expect(resolveMaxWebhookSecret(account({ webhookSecretFile: join(dir, "missing") })))
      .rejects.toThrow(/webhookSecretFile/);
    const target = join(dir, "real");
    writeFileSync(target, "linked-secret");
    const link = join(dir, "link");
    symlinkSync(target, link);
    await expect(resolveMaxWebhookSecret(account({ webhookSecretFile: link }))).rejects.toThrow(/webhookSecretFile/);
  });

  it("rejects secrets MAX would refuse", async () => {
    await expect(resolveMaxWebhookSecret(account({ webhookSecret: "a b c d e" }))).rejects.toThrow(/5–256/);
    await expect(resolveMaxWebhookSecret(account({ webhookSecret: "abcd" }))).rejects.toThrow(/5–256/);
  });

  it("generates a secret once and keeps it in the account state", async () => {
    const state = new MaxStateStore("secret-persist");
    await state.load();
    const first = await resolveMaxWebhookSecret(account({}, "secret-persist"), state);
    expect(first).toMatch(/^[\w-]{5,256}$/);

    const reloaded = new MaxStateStore("secret-persist");
    await reloaded.load();
    expect(reloaded.webhookSecret).toBe(first);
    expect(await resolveMaxWebhookSecret(account({}, "secret-persist"), reloaded)).toBe(first);
  });
});

describe("webhook mode lifecycle", () => {
  it("registers the route, drops foreign subscriptions and subscribes; keeps it on stop", async () => {
    const api = mockApi([
      { url: "https://old.example/hook", time: 1 },
      { url: "https://max.example/max/webhook", time: 2 },
    ]);
    const unregisterRoute = vi.fn();
    const registerWebhookRoute = vi.fn(() => unregisterRoute);
    const statuses: MaxStatusPatch[] = [];
    const controller = new AbortController();
    const log = mockLog();

    const start = startMaxPolling({
      api: api as unknown as MaxApi,
      account: account({
        webhookUrl: "https://max.example/max/webhook",
        webhookSecret: "hook-secret-1",
      }),
      config: {} as OpenClawConfig,
      abortSignal: controller.signal,
      log,
      statusSink: (patch) => statuses.push(patch),
      registerWebhookRoute: registerWebhookRoute as never,
    });

    await runUntil(start, controller, () => expect(api.subscribe).toHaveBeenCalled());

    expect(api.getUpdates).not.toHaveBeenCalled();
    expect(registerWebhookRoute).toHaveBeenCalledTimes(1);
    const routeParams = (registerWebhookRoute.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(routeParams).toMatchObject({ path: "/max/webhook", auth: "plugin", match: "exact", throwOnFailure: true });
    // Route before subscription: MAX may deliver immediately.
    expect(registerWebhookRoute.mock.invocationCallOrder[0])
      .toBeLessThan(api.subscribe.mock.invocationCallOrder[0]);

    expect(api.unsubscribe).toHaveBeenCalledTimes(1);
    expect(api.unsubscribe).toHaveBeenCalledWith("https://old.example/hook");
    expect(api.subscribe).toHaveBeenCalledWith({
      url: "https://max.example/max/webhook",
      update_types: MAX_SUBSCRIBED_UPDATE_TYPES,
      secret: "hook-secret-1",
    });

    // Stop: route released, subscription kept.
    expect(unregisterRoute).toHaveBeenCalledTimes(1);
    expect(api.unsubscribe).toHaveBeenCalledTimes(1);

    // Health: webhook mode never publishes a transport-activity timestamp.
    expect(statuses[0]).toMatchObject({ mode: "webhook", lastTransportActivityAt: null });
    expect(statuses.some((s) => s.connected === true && s.lifecycle === "ready")).toBe(true);
    expect(statuses.every((s) => s.lastTransportActivityAt == null)).toBe(true);
  });

  it("uses the webhookPath override for the route", async () => {
    const api = mockApi([]);
    const registerWebhookRoute = vi.fn(() => () => {});
    const controller = new AbortController();
    const start = startMaxPolling({
      api: api as unknown as MaxApi,
      account: account({
        webhookUrl: "https://max.example/public/path",
        webhookPath: "/internal/max",
        webhookSecret: "hook-secret-2",
      }),
      config: {} as OpenClawConfig,
      abortSignal: controller.signal,
      registerWebhookRoute: registerWebhookRoute as never,
    });
    await runUntil(start, controller, () => expect(api.subscribe).toHaveBeenCalled());
    expect((registerWebhookRoute.mock.calls[0] as unknown[])[0]).toMatchObject({ path: "/internal/max" });
  });

  it("serves updates through the registered target while running", async () => {
    const api = mockApi([]);
    const controller = new AbortController();
    const statuses: MaxStatusPatch[] = [];
    const start = startMaxPolling({
      api: api as unknown as MaxApi,
      account: account({ webhookUrl: "https://max.example/lifecycle/hook", webhookSecret: "lifecycle-secret" }),
      config: {} as OpenClawConfig,
      abortSignal: controller.signal,
      statusSink: (patch) => statuses.push(patch),
      registerWebhookRoute: (() => () => {}) as never,
    });
    await vi.waitFor(() => expect(api.subscribe).toHaveBeenCalled());

    const { Readable } = await import("node:stream");
    const body = JSON.stringify({ update_type: "dialog_cleared", timestamp: 9, chat_id: 1 });
    const req = Object.assign(Readable.from([body]), {
      method: "POST",
      url: "/lifecycle/hook",
      headers: { "x-max-bot-api-secret": "lifecycle-secret" },
      socket: { destroyed: false, writableEnded: false },
    });
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    expect(await handleMaxWebhookRequest(req as never, res as never)).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(statuses.some((s) => s.lastEventAt != null && s.mode === "webhook")).toBe(true);

    controller.abort();
    await start;

    // After stop the path is no longer served.
    const req2 = Object.assign(Readable.from([body]), {
      method: "POST",
      url: "/lifecycle/hook",
      headers: { "x-max-bot-api-secret": "lifecycle-secret" },
      socket: { destroyed: false, writableEnded: false },
    });
    expect(await handleMaxWebhookRequest(req2 as never, res as never)).toBe(false);
  });

  it("fails the start when the route cannot be registered, without subscribing", async () => {
    const api = mockApi([]);
    const controller = new AbortController();
    await expect(startMaxPolling({
      api: api as unknown as MaxApi,
      account: account({ webhookUrl: "https://max.example/max/webhook", webhookSecret: "hook-secret-3" }),
      config: {} as OpenClawConfig,
      abortSignal: controller.signal,
      registerWebhookRoute: (() => {
        throw new Error("plugin: route overlap denied");
      }) as never,
    })).rejects.toThrow(/route overlap/);
    expect(api.subscribe).not.toHaveBeenCalled();
  });

  it("releases the route when POST /subscriptions fails", async () => {
    const api = mockApi([]);
    api.subscribe.mockRejectedValue(new Error("MAX API 400"));
    const unregisterRoute = vi.fn();
    await expect(startMaxPolling({
      api: api as unknown as MaxApi,
      account: account({ webhookUrl: "https://max.example/max/webhook", webhookSecret: "hook-secret-4" }),
      config: {} as OpenClawConfig,
      abortSignal: new AbortController().signal,
      registerWebhookRoute: (() => unregisterRoute) as never,
    })).rejects.toThrow(/MAX API 400/);
    expect(unregisterRoute).toHaveBeenCalledTimes(1);
  });

  it("requires webhookUrl for an explicit webhook transport", async () => {
    await expect(startMaxPolling({
      api: mockApi([]) as unknown as MaxApi,
      account: account({ transport: "webhook" }),
      config: {} as OpenClawConfig,
      abortSignal: new AbortController().signal,
    })).rejects.toThrow(/requires webhookUrl/);
  });
});

describe("polling mode", () => {
  it("removes an active subscription with a warning before polling", async () => {
    const api = mockApi([{ url: "https://stale.example/hook", time: 1 }]);
    const controller = new AbortController();
    api.getUpdates.mockImplementation(async () => {
      controller.abort();
      return { updates: [], marker: null };
    });
    const log = mockLog();

    await startMaxPolling({
      api: api as unknown as MaxApi,
      account: account({ transport: "polling", webhookUrl: "https://ignored.example/hook" }),
      config: {} as OpenClawConfig,
      abortSignal: controller.signal,
      log,
    });

    expect(api.unsubscribe).toHaveBeenCalledWith("https://stale.example/hook");
    expect(api.unsubscribe.mock.invocationCallOrder[0]).toBeLessThan(api.getUpdates.mock.invocationCallOrder[0]);
    expect(api.subscribe).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("long polling gets no updates"));
  });

  it("keeps polling when the subscriptions check fails", async () => {
    const api = mockApi([]);
    api.getSubscriptions.mockRejectedValue(new Error("network"));
    const log = mockLog();
    await clearMaxSubscriptionsForPolling({ api: api as unknown as MaxApi, account: account({}), log });
    expect(api.unsubscribe).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("subscriptions check failed"));
  });

  it("does nothing when there are no subscriptions", async () => {
    const api = mockApi([]);
    const log = mockLog();
    await clearMaxSubscriptionsForPolling({ api: api as unknown as MaxApi, account: account({}), log });
    expect(api.unsubscribe).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("webhook subscription watch", () => {
  const url = "https://max.example/max/webhook";
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function watch(api: ReturnType<typeof mockApi>, controller = new AbortController()) {
    const log = mockLog();
    const stop = startMaxSubscriptionWatch({
      api: api as unknown as MaxApi,
      accountId: "default",
      webhookUrl: url,
      secret: "watch-secret",
      abortSignal: controller.signal,
      log,
    });
    return { log, stop, controller };
  }

  it("checks every 10–15 minutes and leaves a present subscription alone", async () => {
    expect(MAX_SUBSCRIPTION_CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(10 * 60_000);
    expect(MAX_SUBSCRIPTION_CHECK_INTERVAL_MS).toBeLessThanOrEqual(15 * 60_000);
    const api = mockApi([{ url, time: 1 }]);
    const { stop } = watch(api);
    await vi.advanceTimersByTimeAsync(MAX_SUBSCRIPTION_CHECK_INTERVAL_MS - 1);
    expect(api.getSubscriptions).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.getSubscriptions).toHaveBeenCalledTimes(1);
    expect(api.subscribe).not.toHaveBeenCalled();
    stop();
  });

  it("re-subscribes with a warning when MAX dropped our URL", async () => {
    const api = mockApi([{ url: "https://other.example/hook", time: 1 }]);
    const { log, stop } = watch(api);
    await vi.advanceTimersByTimeAsync(MAX_SUBSCRIPTION_CHECK_INTERVAL_MS);
    expect(api.subscribe).toHaveBeenCalledWith({ url, update_types: MAX_SUBSCRIBED_UPDATE_TYPES, secret: "watch-secret" });
    expect(api.unsubscribe).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("is gone"));
    stop();
  });

  it("only logs network errors and retries on the next tick", async () => {
    const api = mockApi([]);
    api.getSubscriptions.mockRejectedValueOnce(new Error("ECONNRESET"));
    const { log, stop } = watch(api);
    await vi.advanceTimersByTimeAsync(MAX_SUBSCRIPTION_CHECK_INTERVAL_MS);
    expect(api.subscribe).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("ECONNRESET"));
    await vi.advanceTimersByTimeAsync(MAX_SUBSCRIPTION_CHECK_INTERVAL_MS);
    expect(api.subscribe).toHaveBeenCalledTimes(1);
    stop();
  });

  it("logs a failed re-subscribe without throwing", async () => {
    const api = mockApi([]);
    api.subscribe.mockRejectedValueOnce(new Error("503"));
    const { log, stop } = watch(api);
    await vi.advanceTimersByTimeAsync(MAX_SUBSCRIPTION_CHECK_INTERVAL_MS);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("re-subscribe failed"));
    stop();
  });

  it("stops when the account is aborted", async () => {
    const api = mockApi([]);
    const { controller } = watch(api);
    controller.abort();
    await vi.advanceTimersByTimeAsync(MAX_SUBSCRIPTION_CHECK_INTERVAL_MS * 3);
    expect(api.getSubscriptions).not.toHaveBeenCalled();
  });

  it("runs inside webhook mode and is cleared on stop", async () => {
    const api = mockApi([]);
    const controller = new AbortController();
    const start = startMaxPolling({
      api: api as unknown as MaxApi,
      account: account({ webhookUrl: url, webhookSecret: "hook-secret-3" }),
      config: {} as OpenClawConfig,
      abortSignal: controller.signal,
      registerWebhookRoute: (() => () => {}) as never,
    });
    await vi.waitFor(() => expect(api.subscribe).toHaveBeenCalledTimes(1));
    api.getSubscriptions.mockClear();
    await vi.advanceTimersByTimeAsync(MAX_SUBSCRIPTION_CHECK_INTERVAL_MS);
    expect(api.getSubscriptions).toHaveBeenCalledTimes(1);
    expect(api.subscribe).toHaveBeenCalledTimes(2);
    controller.abort();
    await start;
    await vi.advanceTimersByTimeAsync(MAX_SUBSCRIPTION_CHECK_INTERVAL_MS * 2);
    expect(api.getSubscriptions).toHaveBeenCalledTimes(1);
  });
});
