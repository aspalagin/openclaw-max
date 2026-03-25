#!/usr/bin/env node

/**
 * MAX Bot API — integration test script
 *
 * Usage:
 *   MAX_BOT_TOKEN=xxx node scripts/test-api.mjs [chat_id]
 *
 * Checks:
 *   1. GET /me         — bot is alive, prints name + user_id
 *   2. GET /updates    — fetches recent updates (short poll, 3s)
 *   3. POST /messages  — sends test message (if chat_id provided)
 */

const API = "https://platform-api.max.ru";
const TOKEN = process.env.MAX_BOT_TOKEN;
const CHAT_ID = process.argv[2] ? Number(process.argv[2]) : null;

if (!TOKEN) {
  console.error("❌ MAX_BOT_TOKEN is not set. Export it first:");
  console.error("   export MAX_BOT_TOKEN=your_token_here");
  process.exit(1);
}

const headers = {
  Authorization: TOKEN,
  Accept: "application/json",
};

// ─── Helpers ────────────────────────────────────────────────────

async function apiGet(path) {
  const url = `${API}${path}`;
  console.log(`→ GET ${url}`);
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function apiPost(path, body) {
  const url = `${API}${path}`;
  console.log(`→ POST ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

function ok(msg) {
  console.log(`✅ ${msg}`);
}

function fail(msg) {
  console.error(`❌ ${msg}`);
}

// ─── Test 1: GET /me ────────────────────────────────────────────

async function testMe() {
  console.log("\n── Test 1: GET /me ──");
  try {
    const me = await apiGet("/me");
    ok(`Bot is alive!`);
    console.log(`   user_id:    ${me.user_id}`);
    console.log(`   name:       ${me.first_name ?? me.name ?? "–"}`);
    console.log(`   username:   ${me.username ?? "–"}`);
    console.log(`   is_bot:     ${me.is_bot}`);
    return me;
  } catch (err) {
    fail(`GET /me failed: ${err.message}`);
    return null;
  }
}

// ─── Test 2: GET /updates ───────────────────────────────────────

async function testUpdates() {
  console.log("\n── Test 2: GET /updates (short poll, 3s) ──");
  try {
    const data = await apiGet("/updates?timeout=3&limit=5");
    const count = data.updates?.length ?? 0;
    ok(`Got ${count} update(s), marker=${data.marker ?? "null"}`);

    if (count > 0) {
      for (const u of data.updates) {
        const type = u.update_type;
        const ts = new Date(u.timestamp).toISOString();
        let info = "";

        if (type === "message_created" && u.message) {
          const sender = u.message.sender;
          const text = u.message.body?.text ?? "(no text)";
          const sName = sender
            ? `${sender.first_name ?? ""} ${sender.last_name ?? ""}`.trim()
            : "unknown";
          info = `from=${sName} (${sender?.user_id}): "${text.slice(0, 60)}"`;
        } else if (type === "bot_started") {
          info = `user=${u.user?.first_name} (${u.user?.user_id})`;
        }

        console.log(`   [${ts}] ${type} ${info}`);
      }
    }
    return data;
  } catch (err) {
    fail(`GET /updates failed: ${err.message}`);
    return null;
  }
}

// ─── Test 3: POST /messages ─────────────────────────────────────

async function testSendMessage(chatId) {
  console.log(`\n── Test 3: POST /messages (chat_id=${chatId}) ──`);
  try {
    const now = new Date().toISOString();
    const body = {
      text: `🤖 Тестовое сообщение от MAX-бота.\nВремя: ${now}`,
      format: "markdown",
    };
    const data = await apiPost(`/messages?chat_id=${chatId}`, body);
    ok(`Message sent!`);
    console.log(`   message_id: ${data.message?.body?.mid ?? JSON.stringify(data).slice(0, 100)}`);
    return data;
  } catch (err) {
    fail(`POST /messages failed: ${err.message}`);
    return null;
  }
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log("═══ MAX Bot API Test ═══");
  console.log(`Token: ${TOKEN.slice(0, 8)}...${TOKEN.slice(-4)}`);

  const me = await testMe();
  if (!me) {
    console.error("\nBot unreachable. Check your token.");
    process.exit(1);
  }

  await testUpdates();

  if (CHAT_ID) {
    await testSendMessage(CHAT_ID);
  } else {
    console.log("\n── Test 3: skipped (no chat_id) ──");
    console.log("   To test sending, run:");
    console.log(`   MAX_BOT_TOKEN=... node scripts/test-api.mjs <chat_id>`);
    console.log("   (Write to the bot first, then grab chat_id from updates)");
  }

  console.log("\n═══ Done ═══");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
