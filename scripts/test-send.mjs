#!/usr/bin/env node

/**
 * MAX Bot API — send + edit + delete integration test
 *
 * Usage:
 *   MAX_BOT_TOKEN=xxx node scripts/test-send.mjs <chat_id> [текст]
 *
 * Flow:
 *   1. Send message to chat_id
 *   2. Wait 3 seconds
 *   3. Edit message (append " ✅ отредактировано")
 *   4. Wait 3 seconds
 *   5. Delete message
 */

const API = "https://platform-api.max.ru";
const TOKEN = process.env.MAX_BOT_TOKEN;
const CHAT_ID = process.argv[2];
const TEXT = process.argv[3] || "🤖 Тестовое сообщение от MAX-бота";

if (!TOKEN) {
  console.error("❌ MAX_BOT_TOKEN is not set.");
  console.error("   export MAX_BOT_TOKEN=your_token_here");
  process.exit(1);
}

if (!CHAT_ID) {
  console.error("❌ chat_id not provided.");
  console.error("   Usage: MAX_BOT_TOKEN=xxx node scripts/test-send.mjs <chat_id> [текст]");
  console.error("   Tip: get chat_id from `node scripts/test-api.mjs` updates");
  process.exit(1);
}

const headers = {
  Authorization: TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Step 1: Send ───────────────────────────────────────────────

async function sendMessage(chatId, text) {
  console.log(`\n── Step 1: POST /messages (send) ──`);
  console.log(`   chat_id: ${chatId}`);
  console.log(`   text: "${text}"`);

  const url = `${API}/messages?chat_id=${chatId}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Send failed: HTTP ${res.status} — ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const mid = data.message?.body?.mid;

  if (!mid) {
    console.log("   Response:", JSON.stringify(data).slice(0, 200));
    throw new Error("No message_id in response");
  }

  console.log(`   ✅ Sent! message_id: ${mid}`);
  return mid;
}

// ─── Step 2: Edit ───────────────────────────────────────────────

async function editMessage(messageId, newText) {
  console.log(`\n── Step 3: PUT /messages (edit) ──`);
  console.log(`   message_id: ${messageId}`);
  console.log(`   new text: "${newText}"`);

  const url = `${API}/messages?message_id=${messageId}`;
  const res = await fetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify({ text: newText }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Edit failed: HTTP ${res.status} — ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  if (data.success === false) {
    throw new Error(`Edit failed: ${data.message || "unknown"}`);
  }

  console.log(`   ✅ Edited!`);
}

// ─── Step 3: Delete ─────────────────────────────────────────────

async function deleteMessage(messageId) {
  console.log(`\n── Step 5: DELETE /messages (delete) ──`);
  console.log(`   message_id: ${messageId}`);

  const url = `${API}/messages?message_id=${messageId}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: TOKEN,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Delete failed: HTTP ${res.status} — ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  if (data.success === false) {
    throw new Error(`Delete failed: ${data.message || "unknown"}`);
  }

  console.log(`   ✅ Deleted!`);
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log("═══ MAX Bot API: Send → Edit → Delete Test ═══");
  console.log(`Token: ${TOKEN.slice(0, 8)}...${TOKEN.slice(-4)}`);
  console.log(`Chat:  ${CHAT_ID}`);

  // Step 1: Send
  const mid = await sendMessage(CHAT_ID, TEXT);

  // Step 2: Wait
  console.log(`\n── Step 2: Ожидание 3 сек... ──`);
  await sleep(3000);

  // Step 3: Edit
  const editedText = `${TEXT} ✅ отредактировано`;
  await editMessage(mid, editedText);

  // Step 4: Wait
  console.log(`\n── Step 4: Ожидание 3 сек... ──`);
  await sleep(3000);

  // Step 5: Delete
  await deleteMessage(mid);

  console.log("\n═══ All steps passed! ═══");
}

main().catch((err) => {
  console.error(`\n❌ Fatal: ${err.message}`);
  process.exit(1);
});
