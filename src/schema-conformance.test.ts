/**
 * Conformance with the published MAX Bot API schema (max-messenger/api-schema).
 *
 * The snapshot lives in src/__fixtures__/max-schema-<version>.yaml and is
 * refreshed by `npm run schema:update`. Requests are captured from the real
 * send/subscribe/api paths through a mocked fetch, so a field or type the
 * plugin sends but the schema lacks fails here before it fails live.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import type { ResolvedMaxAccount } from "./accounts.js";
import { MaxApi } from "./api.js";
import { MAX_SUBSCRIBED_UPDATE_TYPES } from "./monitor.js";
import {
  detectMaxMediaType,
  MAX_SEND_BUTTON_TYPES,
  type MaxSendButton,
  sendMaxContact,
  sendMaxLocation,
  sendMaxMediaMessage,
  sendMaxMessage,
  sendMaxSticker,
} from "./send.js";
import { subscribeMaxWebhook } from "./webhook.js";
import { resolveMaxWebhookSecret } from "./webhook-runner.js";

type Schema = Record<string, unknown> & {
  properties?: Record<string, unknown>;
  required?: string[];
  allOf?: Schema[];
  $ref?: string;
  discriminator?: { propertyName: string; mapping: Record<string, string> };
};
type OpenApi = {
  info: { version: string };
  paths: Record<string, Record<string, { parameters?: Array<{ name: string }> }>>;
  components: { schemas: Record<string, Schema> };
};

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "__fixtures__");
const snapshots = readdirSync(fixturesDir).filter((name) => /^max-schema-.+\.yaml$/.test(name));
const schema = parse(readFileSync(join(fixturesDir, snapshots[0] ?? "missing.yaml"), "utf8")) as OpenApi;
const schemas = schema.components.schemas;
const source = (file: string) => readFileSync(join(here, file), "utf8");

function schemaByRef(ref: string): Schema {
  const name = ref.replace("#/components/schemas/", "");
  const found = schemas[name];
  if (!found) throw new Error(`schema ${name} not found`);
  return found;
}

/** Property names of a schema, following allOf and $ref (inheritance chains). */
function propertiesOf(target: string | Schema): Set<string> {
  const node = typeof target === "string" ? schemaByRef(`#/components/schemas/${target}`) : target;
  const props = new Set(Object.keys(node.properties ?? {}));
  if (node.$ref) for (const prop of propertiesOf(schemaByRef(node.$ref))) props.add(prop);
  for (const part of node.allOf ?? []) for (const prop of propertiesOf(part)) props.add(prop);
  return props;
}

function mappingKeys(name: string): Set<string> {
  const mapping = schemas[name]?.discriminator?.mapping;
  if (!mapping) throw new Error(`${name} has no discriminator mapping`);
  return new Set(Object.keys(mapping));
}

function expectSubset(actual: Iterable<string>, allowed: Set<string>, label: string) {
  const extra = [...actual].filter((value) => !allowed.has(value));
  expect(extra, `${label}: not in schema ${schema.info.version}`).toEqual([]);
}

type Captured = { method: string; url: URL; body: Record<string, unknown> | undefined };

function captureFetch(json: unknown = { message: { body: { mid: "mid.1" }, recipient: { chat_id: 1 }, timestamp: 1 } }) {
  const calls: Captured[] = [];
  global.fetch = vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    calls.push({
      method: String(init?.method ?? "GET"),
      url: new URL(url),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => json };
  }) as never;
  return calls;
}

const updateMapping = mappingKeys("Update");

describe(`MAX schema snapshot`, () => {
  it("is a single snapshot of the published schema", () => {
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toBe(`max-schema-${schema.info.version}.yaml`);
  });
});

describe("update types", () => {
  it("subscribes only to update types from Update.discriminator.mapping", () => {
    expectSubset(MAX_SUBSCRIBED_UPDATE_TYPES, updateMapping, "subscribed update_types");
  });

  it("the webhook subscribe default list matches the subscribed update types", async () => {
    const calls = captureFetch({ success: true });
    await subscribeMaxWebhook({ api: new MaxApi({ token: "t" }), webhookUrl: "https://bot.example/max/webhook" });
    expect(calls[0].body?.update_types).toEqual(MAX_SUBSCRIBED_UPDATE_TYPES);
  });

  it("MaxUpdateType and the dispatch switch know only schema update types", () => {
    const union = /export type MaxUpdateType =([^;]+);/.exec(source("types.ts"))?.[1] ?? "";
    const declared = [...union.matchAll(/"(\w+)"/g)].map((m) => m[1]);
    const handled = [...source("dispatch.ts").matchAll(/case "(\w+)":/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(10);
    expect(handled.length).toBeGreaterThan(5);
    expectSubset(declared, updateMapping, "MaxUpdateType");
    expectSubset(handled, updateMapping, "dispatchUpdate cases");
    // Every subscribed type has its own branch in dispatchUpdate.
    expectSubset(MAX_SUBSCRIBED_UPDATE_TYPES, new Set(handled), "subscribed without a dispatch case");
  });

  it("message_callback carries message next to callback; audio carries transcription", () => {
    const callbackProps = propertiesOf("MessageCallbackUpdate");
    expect(callbackProps.has("callback")).toBe(true);
    expect(callbackProps.has("message")).toBe(true);
    expect(propertiesOf("AudioAttachment").has("transcription")).toBe(true);
  });
});

describe("attachments", () => {
  it("inbound attachment handling covers only schema Attachment types", () => {
    const text = source("inbound-attachments.ts");
    const media = /\[((?:"\w+",?\s*)+)\]\.includes\(attType\)/.exec(text)?.[1] ?? "";
    const types = new Set([
      ...[...media.matchAll(/"(\w+)"/g)].map((m) => m[1]),
      ...[...text.matchAll(/attType\s*[!=]==\s*"(\w+)"/g)].map((m) => m[1]),
    ]);
    expect(types.size).toBeGreaterThan(5);
    expectSubset(types, mappingKeys("Attachment"), "inbound attachment types");
  });

  it("upload types are AttachmentRequest types", () => {
    const kinds = ["a.jpg", "a.mp4", "a.ogg", "a.pdf"].map((file) => detectMaxMediaType(file));
    expectSubset(kinds, mappingKeys("AttachmentRequest"), "upload types");
  });
});

describe("outbound requests", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("send bodies use NewMessageBody fields, AttachmentRequest types and payload fields", async () => {
    const calls = captureFetch();
    const opts = { token: "t", replyToMessageId: "mid.0", format: "markdown" as const, notify: false };
    await sendMaxMessage("1", "**hi**", { ...opts, buttons: [[{ text: "Ok", payload: "ok" }]] });
    await sendMaxMediaMessage("1", "caption", "https://cdn.example/photo.jpg", opts);
    await sendMaxLocation("1", { latitude: 55.75, longitude: 37.62 }, "here", opts);
    await sendMaxContact("1", { name: "Ann", contactId: 7, vcfPhone: "+70000000000" }, opts);
    await sendMaxContact("1", { name: "Bob", vcfPhone: "+70000000001" }, opts);
    await sendMaxSticker("1", "abc123", opts);

    expect(calls).toHaveLength(6);
    const newMessageBody = propertiesOf("NewMessageBody");
    const requestTypes = mappingKeys("AttachmentRequest");
    for (const { method, url, body } of calls) {
      expect(`${method} ${url.pathname}`).toBe("POST /messages");
      expect(schema.paths["/messages"]?.post).toBeDefined();
      expectSubset(Object.keys(body ?? {}), newMessageBody, "NewMessageBody");
      expectSubset(Object.keys((body?.link as object) ?? {}), propertiesOf("NewMessageLink"), "NewMessageLink");
      for (const attachment of (body?.attachments as Array<Record<string, unknown>>) ?? []) {
        expectSubset([String(attachment.type)], requestTypes, "attachment type");
        const requestSchema = schemaByRef(schemas.AttachmentRequest.discriminator!.mapping[String(attachment.type)]);
        expectSubset(Object.keys(attachment), propertiesOf(requestSchema), `${String(attachment.type)} attachment`);
      }
    }
    const contacts = calls.slice(3, 5).map((call) => (call.body?.attachments as Array<{ payload: object }>)[0].payload);
    for (const payload of contacts) {
      expectSubset(Object.keys(payload), propertiesOf("ContactAttachmentRequestPayload"), "ContactAttachmentRequestPayload");
    }
  });

  it("every button type the plugin builds is a schema Button with schema fields", async () => {
    expectSubset(MAX_SEND_BUTTON_TYPES, mappingKeys("Button"), "button types");
    const calls = captureFetch();
    const buttons: MaxSendButton[] = [...MAX_SEND_BUTTON_TYPES].map((type) => ({
      text: type,
      type: type as MaxSendButton["type"],
      url: type === "link" ? "https://example.org" : undefined,
      webApp: type === "open_app" ? "mini_app_bot" : undefined,
      payload: type === "callback" || type === "clipboard" || type === "open_app" ? "p-1" : undefined,
    }));
    await sendMaxMessage("1", "buttons", { token: "t", buttons: [buttons] });

    const keyboard = (calls[0].body?.attachments as Array<{ payload: { buttons: Array<Array<Record<string, unknown>>> } }>)[0];
    const built = keyboard.payload.buttons[0];
    expect(built.map((button) => button.type)).toEqual([...MAX_SEND_BUTTON_TYPES]);
    for (const button of built) {
      const buttonSchema = schemaByRef(schemas.Button.discriminator!.mapping[String(button.type)]);
      expectSubset(Object.keys(button), propertiesOf(buttonSchema), `${String(button.type)} button`);
    }
  });

  it("webhook subscription body matches SubscriptionRequestBody and the secret pattern", async () => {
    const calls = captureFetch({ success: true });
    const account = { accountId: "schema", config: {} } as ResolvedMaxAccount;
    const secret = await resolveMaxWebhookSecret(account);
    await subscribeMaxWebhook({
      api: new MaxApi({ token: "t" }),
      webhookUrl: "https://bot.example/max/webhook",
      secret,
      updateTypes: MAX_SUBSCRIBED_UPDATE_TYPES,
    });

    expect(`${calls[0].method} ${calls[0].url.pathname}`).toBe("POST /subscriptions");
    const body = schemas.SubscriptionRequestBody;
    expectSubset(Object.keys(calls[0].body ?? {}), propertiesOf(body), "SubscriptionRequestBody");
    for (const required of body.required ?? []) expect(calls[0].body).toHaveProperty(required);
    const secretSchema = body.properties?.secret as { pattern: string; minLength: number; maxLength: number };
    expect(secret).toMatch(new RegExp(secretSchema.pattern));
    expect(secret.length).toBeGreaterThanOrEqual(secretSchema.minLength);
    expect(secret.length).toBeLessThanOrEqual(secretSchema.maxLength);
  });

  it("bot commands go to PATCH /me/commands, which the schema has (and PATCH /me it has not)", async () => {
    expect(schema.paths["/me/commands"]?.patch).toBeDefined();
    expect(schema.paths["/me"]?.patch).toBeUndefined();
    const calls = captureFetch({ commands: [] });
    await new MaxApi({ token: "t" }).setMyCommands([{ name: "/start", description: "Start" }]);
    expect(`${calls[0].method} ${calls[0].url.pathname}`).toBe("PATCH /me/commands");
    const requestSchema = (schema.paths["/me/commands"]?.patch as unknown as {
      requestBody: { content: { "application/json": { schema: Schema } } };
    }).requestBody.content["application/json"].schema;
    expectSubset(Object.keys(calls[0].body ?? {}), propertiesOf(requestSchema), "PATCH /me/commands body");
    for (const command of (calls[0].body?.commands as Array<Record<string, unknown>>) ?? []) {
      expectSubset(Object.keys(command), propertiesOf("BotCommand"), "BotCommand");
    }
  });

  it("GET /messages paging uses the schema's before/after parameters", async () => {
    const params = new Set((schema.paths["/messages"]?.get?.parameters ?? []).map((param) => param.name));
    expect(params.has("before")).toBe(true);
    expect(params.has("after")).toBe(true);
    const calls = captureFetch({ messages: [] });
    await new MaxApi({ token: "t" }).getMessages(1, { message_ids: ["mid.1"], before: 2, after: 1, count: 5 });
    expect(calls[0].url.pathname).toBe("/messages");
    expectSubset(calls[0].url.searchParams.keys(), params, "GET /messages query");
  });
});
