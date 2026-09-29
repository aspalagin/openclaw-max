# openclaw-max — MAX messenger channel for OpenClaw

[Русская версия](README.md)

A channel plugin that connects an [OpenClaw](https://openclaw.ai) assistant to the [MAX](https://max.ru) messenger through the MAX Bot API (`platform-api2.max.ru`). People write to your bot in MAX — in a private dialog or in a group — and the OpenClaw agent answers there, with media, buttons and voice.

It is for OpenClaw users who need their assistant reachable in MAX. You need a MAX bot token (bots are created by organisations on [business.max.ru](https://business.max.ru/self)) and an OpenClaw gateway you run yourself.

Version 0.8.0. Changes: [CHANGELOG.md](https://github.com/aspalagin/openclaw-max/blob/main/CHANGELOG.md) (in Russian).

## Contents

- [Supported message types](#supported-message-types)
- [Requirements and compatibility](#requirements-and-compatibility)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Transports: webhook and long polling](#transports-webhook-and-long-polling)
- [Configuration reference](#configuration-reference)
- [Access and policies](#access-and-policies)
- [`message` tool actions and their scope](#message-tool-actions-and-their-scope)
- [Media and local files](#media-and-local-files)
- [Voice](#voice)
- [Commands and menus](#commands-and-menus)
- [Turn status](#turn-status)
- [Multiple accounts and inheritance](#multiple-accounts-and-inheritance)
- [Proxy, API address and the Russian Trusted CA](#proxy-api-address-and-the-russian-trusted-ca)
- [Secrets and SecretRef](#secrets-and-secretref)
- [Reliability](#reliability)
- [MAX API limits](#max-api-limits)
- [Security](#security)
- [Privacy](#privacy)
- [Troubleshooting](#troubleshooting)
- [Upgrading from 0.7](#upgrading-from-07)
- [Development](#development)
- [Acknowledgements, authors and license](#acknowledgements-authors-and-license)

## Supported message types

| Type | Incoming (MAX → agent) | Outgoing (agent → MAX) |
|---|---|---|
| Text | Yes; mentions detected from MAX markup, `@username` and core mention patterns | Yes; markdown converted to the MAX dialect (`++underline++`), split at 4000 characters; if MAX rejects the markup, resent once as plain text |
| Image | Downloaded and passed to the agent as media | Yes; several images and videos go as albums of up to 12; a public https image URL is passed to MAX as a link |
| Video | Downloaded (size limit `mediaMaxMb`) | Yes |
| Audio and voice | Downloaded; the MAX transcript is used when present, otherwise OpenClaw core transcribes | Yes; `asVoice` / `audioAsVoice` sends a MAX `audio` attachment |
| File | Downloaded | Yes, from an allowed local path, a URL or inline `buffer` |
| Sticker | Sticker code and image | `sticker` action by code |
| Contact | Name and phones parsed from the VCard, MAX profile | `sendAttachment` with `type="contact"` |
| Location | Coordinates and a map link | `sendAttachment` with `type="location"` |
| Share card | Title, description and link | — |
| Forwarded message | Text and attachments with the original author; the sender's own comment comes first | — |
| Reply | Quote of the replied-to message (up to 1000 characters) and its author | Yes, as a MAX reply (`replyTo`) |
| Inline keyboard | Button presses: callbacks, approvals, command menus | 7 button types (callback, link, message, clipboard, open_app, request_contact, request_geo_location); OpenClaw `presentation` blocks rendered as text and keyboards |
| Edited message | Processed again as a new message | `edit` action; draft streaming edits one message |
| Deleted message | Ignored (logged at debug level) | `delete` action |
| Pin | — | `pin` / `unpin` in groups and channels; `delivery.pin` |
| Bot start (deep link) | Delivered to the agent as `/start` or `/start <payload>`; like messages, skipped when older than `maxEventAgeMinutes` | — |
| Typing indicator, read receipt | — | `typing_on` for the whole turn; `mark_seen` on incoming messages (`markSeen`) |

Reactions and polls are not supported.

## Requirements and compatibility

- OpenClaw ≥ 2026.9.6 (`peerDependencies.openclaw`, `openclaw.compat.minGatewayVersion`). Older releases do not work, checked against 2026.9.3–2026.9.5 by typecheck and the test suite: 2026.9.5 lacks `createLivePreviewLifecycle` in `openclaw/plugin-sdk/channel-outbound`, so the plugin module fails to load (turn status is built on it); 2026.9.3 and 2026.9.4 also lack the sender check for answering agent questions with buttons (`authorize` in `resolveOption`), the guarded heartbeat typing hook and the plan-explanation format. Upgrade OpenClaw to use this plugin.
- Node.js ≥ 22.
- MAX Bot API as described by schema 0.0.33 and [dev.max.ru/docs-api](https://dev.max.ru/docs-api).
- For webhook mode: a public HTTPS address on port 443 with a trusted certificate that reaches the gateway's HTTP server.

**Verification status.** Version 0.8.0 has been in production use since 27 September 2026 with OpenClaw 2026.9.6 in webhook mode. Verified live: start and webhook subscription, channel status (`mode`, `tokenStatus`), text in a direct chat, long answers in parts, core commands, sends through the `message` tool, including a file from the agent workspace and the refusal of a file of a type that is not allowed, and recovery of the durable queue after a real gateway restart — a message core refused while the gateway was shutting down waited for the next start and was answered. Versions 0.7.x were in production use before that with text, media, buttons, both transports and incoming voice transcription over webhook. The rest of what is new in 0.8.0 is covered by the automated test suite and has passed an independent code review, but has not been checked live yet — among it the HTTP proxy and `apiBaseUrl`, SecretRef resolution at gateway start, turn status, command menus, voice replies, forwarded messages, groups and long polling.

## Installation

From ClawHub:

```bash
openclaw plugins install clawhub:@aspalagin/openclaw-max
```

From npm:

```bash
openclaw plugins install npm:@aspalagin/openclaw-max
```

> Use the scoped name `@aspalagin/openclaw-max`. The unscoped npm package `openclaw-max` is a different project (see [Acknowledgements](#acknowledgements-authors-and-license)).

Restart the gateway after installing so it loads the plugin. The plugin id in OpenClaw is `openclaw-max`, the channel id is `max`.

To update: `openclaw plugins update openclaw-max` for an npm install, or `openclaw plugins install clawhub:@aspalagin/openclaw-max --force` for a ClawHub install; then restart the gateway. Read [Upgrading from 0.7](#upgrading-from-07) first.

## Quick start

1. **Create a bot.** On [business.max.ru](https://business.max.ru/self) (a registered organisation or sole trader is required) open **Chat bots → Create**, wait for moderation, then copy the token under **Chat bots → Integration**.
2. **Store the token** in a file readable by the gateway user, for example `/home/you/.openclaw/secrets/max-bot-token` (mode `0600`). The path is used as given: use an absolute path; `~` is not expanded. It must be a regular file: a symbolic link is not read, as if the file were missing.
3. **Configure** `~/.openclaw/openclaw.json`:

   ```jsonc
   {
     "channels": {
       "max": {
         "enabled": true,
         "tokenFile": "/home/you/.openclaw/secrets/max-bot-token",
         "dmPolicy": "pairing",
         // Webhook (recommended by MAX for production); omit both keys for long polling
         "webhookUrl": "https://bot.example.com/max/webhook",
         "webhookSecretFile": "/home/you/.openclaw/secrets/max-webhook-secret"
       }
     }
   }
   ```

4. **Restart the gateway**: `openclaw gateway restart`.
5. **Check the account**: `openclaw channels status` shows the account, `tokenSource`, `tokenStatus` and `mode`; `openclaw channels status --probe` also calls the MAX API.
6. **Write to the bot** in MAX. With `dmPolicy: "pairing"` you get a pairing code; approve it with `openclaw pairing approve max <code>` (`openclaw pairing list max` lists pending requests with the sender's user id). Put your user id into `allowFrom` to skip pairing.

The token can also come from `botToken` (a string or a [SecretRef](#secrets-and-secretref)) or from the `MAX_BOT_TOKEN` environment variable (top-level account only). Order: `botToken`, then `tokenFile`, then `MAX_BOT_TOKEN`.

## Transports: webhook and long polling

**Use webhook mode in production.** MAX documents long polling as a development and testing mode, limited in speed and event retention, and asks for webhooks in production ([GET /updates](https://dev.max.ru/docs-api/methods/GET/updates)). Other plugins also report that voice messages may arrive empty or not at all over long polling (notably from Android); MAX does not document this and we have not confirmed it yet — over webhook, voice messages arrive and are transcribed.

`transport` selects the mode: `webhook` when `webhookUrl` is set, otherwise `polling`. `transport: "webhook"` without `webhookUrl` is a config error.

### Webhook

- **MAX requirements:** HTTPS on port 443 with a certificate from a trusted CA; a `200` answer within 30 seconds; MAX retries failed deliveries and removes the subscription after 8 hours of failures. Each request carries the `X-Max-Bot-Api-Secret` header. While a webhook subscription is active, long polling does not work.
- **Route:** the plugin serves the webhook on the gateway's own HTTP server (no extra port). Path: `webhookPath`, otherwise the path of `webhookUrl`, otherwise `/max/webhook`. Put a reverse proxy or tunnel with a valid certificate in front of the gateway and forward only this path.
- **Secret:** `webhookSecret`, else `webhookSecretFile`, else generated once and kept in the account state file. Format required by MAX: 5–256 characters `A–Z a–z 0–9 _ -`. The secret is compared in constant time before the body is read; a mismatch gets `401`.
- **Subscription:** at start the plugin removes this bot's subscriptions to other URLs and subscribes `webhookUrl`. Every 12 minutes it checks that the subscription still exists and recreates it if MAX removed it. On stop the subscription is kept, so events that arrive during a restart are redelivered by MAX.
- **Processing:** the HTTP handler checks the secret, the body and duplicates, records the event (see [Reliability](#reliability)) and answers; the agent runs in the account task — in order within a chat, up to 4 chats in parallel.
- **Turning it on:** deploy the plugin and restart the gateway first, then add `webhookUrl` and restart again; check that the log shows `MAX webhook subscribed` and that a message reaches the agent.
- **Rolling back:** set `transport: "polling"` (or remove `webhookUrl`) and restart; the polling start removes the subscription. If the plugin cannot start, remove it by hand: `curl -X DELETE "<api>/subscriptions?url=<webhookUrl>" -H "Authorization: <token>"`, where `<api>` is your `apiBaseUrl` or, if it is not set, `https://platform-api2.max.ru`.

### Long polling

The plugin polls `GET /updates` and stores the marker in the account state file after each batch, so a restart continues where it stopped. After an error it waits 2 s, doubling up to 60 s with jitter, honours `Retry-After`, and after `401` retries every 5 minutes. At start, an active webhook subscription of the bot is removed with a warning (MAX does not serve `GET /updates` while it exists).

## Configuration reference

All options live under `channels.max`; the same keys (except `accounts` and `commands`) are accepted under `channels.max.accounts.<id>`. "Own" options belong to one bot and are not inherited by named accounts; everything else is inherited from the channel level (see [Multiple accounts](#multiple-accounts-and-inheritance)).

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` at channel level disables all accounts |
| `botToken` | string or SecretRef | — | Bot token. Own |
| `tokenFile` | string | — | Absolute path to a regular file with the token. Own |
| `name` | string | — | Display name of the account. Own |
| `transport` | `polling` \| `webhook` | `webhook` if `webhookUrl` is set, else `polling` | Own |
| `webhookUrl` | string | — | Public HTTPS URL MAX posts to. Own |
| `webhookSecret` | string or SecretRef | generated | Webhook secret. Own |
| `webhookSecretFile` | string | — | File with the webhook secret (regular file, not a symlink). Own |
| `webhookPath` | string | path of `webhookUrl`, else `/max/webhook` | Gateway route path. Own |
| `webhookQueue.mode` | `durable` \| `memory` | `durable` | Journal accepted webhook events on disk or keep them in memory only |
| `webhookQueue.maxPending` | integer | `5000` | Accepted but unprocessed events |
| `webhookQueue.overflow` | `reject` \| `drop` | `reject` | When full: answer `503` so MAX retries, or acknowledge and drop |
| `maxEventAgeMinutes` | integer ≥ 0 | `60` | Skip messages, edits, button presses and bot starts older than this (by MAX event time); `0` — no limit |
| `dmPolicy` | `pairing` \| `allowlist` \| `open` \| `disabled` | `pairing` | Who may write in private dialogs |
| `allowFrom` | array of user ids | `[]` | Allowed private senders; `"*"` — anyone (required with `open`) |
| `groupPolicy` | `allowlist` \| `open` \| `disabled` | `allowlist` (or core `channels.defaults.groupPolicy`) | Which groups the bot answers in |
| `groups` | object keyed by chat id or `"*"` | `{}` | Allowed groups and per-group settings, see below |
| `groupAllowFrom` | array of user ids | — | Senders allowed in admitted groups (when the group has no own `allowFrom`) |
| `mentionPatterns` | `{ mode: "allow" \| "deny", allowIn, denyIn }` | allow | Where core mention patterns apply in MAX groups |
| `actionScope` | `admitted` \| `current` \| `off` | `admitted` | Chats the `message` tool may act in |
| `notify` | boolean | MAX default (notify) | Push notifications for sends; `false` — silent (not possible in channels) |
| `disableLinkPreview` | boolean | MAX default (previews on), off for tool summaries | Link previews for sends; a set value applies to tool summaries too |
| `markSeen` | boolean | `true` | Mark incoming messages as read |
| `mediaMaxMb` | number | `20` | Size limit for downloaded and uploaded media, MB |
| `mediaMaxCount` | integer | `12` | Media attachments downloaded per incoming message, forwards included |
| `streamMode` | `off` \| `partial` \| `block` | `off` | `partial` — one draft message edited while the answer streams; `block` — core block replies |
| `streaming` | core streaming config | off | `streaming.mode` (`off`, `partial`, `block`, `progress`) wins over `streamMode`; `streaming.progress.*` configures [turn status](#turn-status) |
| `textChunkLimit` | integer | `4000` | Characters per outgoing message, account value first; values above MAX's 4000 are capped |
| `responsePrefix` | string | — | Prefix of agent replies, applied by OpenClaw core (`"auto"` — agent name) |
| `historyLimit` | integer ≥ 0 | core default | Read by OpenClaw core: recent turns of a group session the embedded agent runtime keeps in the prompt (native CLI runtimes keep their own history) |
| `dmHistoryLimit`, `dms.<userId>.historyLimit` | integer ≥ 0 | no limit | Read by OpenClaw core: the same for private dialogs with a per-channel session (`session.dmScope`), per user first |
| `actions` | object `{ <action>: boolean }` | all on | `false` turns a `message` tool action off (`send`, `edit`, `delete`, `sticker`, `sendAttachment`, `pin`, `unpin`): hidden from the tool and refused |
| `apiBaseUrl` | string | `https://platform-api2.max.ru` | Bot API base URL; `https` only, `http` just for loopback |
| `httpProxy` | string or SecretRef | — | HTTP(S) proxy for all MAX traffic; `""` in an account turns an inherited proxy off |
| `logMessagePreview` | boolean | `false` | Add a 50-character text preview to debug logs |
| `commands` | array of `{ name, description }` | — | Channel level only: bot commands registered in MAX (up to 32; name ≤ 64 characters without `/`, description ≤ 128) |
| `accounts` | object | — | Channel level only: named accounts |

Per-group settings (`groups.<chatId>` or `groups["*"]`):

| Key | Default | Description |
|---|---|---|
| `requireMention` | `true` | Answer only when the bot is mentioned, replied to or its button is pressed |
| `allowFrom` | — | Senders allowed in this group (overrides `groupAllowFrom`) |
| `tools` | — | Core tool policy for this group |
| `disableAudioPreflight` | `false` | Do not transcribe captionless voice messages to look for a mention |
| `enabled` | `true` | `false` — ignore this group under any `groupPolicy` |
| `systemPrompt` | — | Extra system prompt for turns in this group |
| `skills` | all | Skills a turn in this group may load; `[]` — none |

Accepted by the schema for compatibility with the common channel config shape but **without effect in MAX** — neither the plugin nor OpenClaw core reads them for this channel: `markdown` (table rendering), `blockStreaming` (use `streamMode` or `streaming.mode: "block"`), `blockStreamingCoalesce` (core reads `streaming.block.coalesce`). They stay in the schema so existing configs keep validating.

## Access and policies

**Private dialogs** (`dmPolicy`):

- `pairing` (default) — unknown senders get a pairing code; the owner approves it with `openclaw pairing approve max <code>`. Senders in `allowFrom` need no pairing.
- `allowlist` — only user ids in `allowFrom`.
- `open` — anyone; requires `allowFrom: ["*"]`.
- `disabled` — no private messages.

**Groups** (`groupPolicy`):

- `allowlist` (default) — only chats listed in `groups` (or any chat if `groups` has a `"*"` entry).
- `open` — any group the bot is in.
- `disabled` — no group messages.

In an admitted group, a non-empty `groups.<id>.allowFrom` (else `groupAllowFrom`) restricts who can talk to the bot: messages, button presses, commands and voice checks from other members are ignored, and their attachments are not downloaded. `"*"` allows anyone; the `max:` prefix is accepted in ids. The private `allowFrom` list does **not** apply to groups.

**Mentions.** With `requireMention` (default `true`) the bot answers in a group when it is mentioned (`@username` or a MAX mention), when someone replies to its message or presses its button, or when the text matches mention patterns configured in OpenClaw core (`messages.groupChat.mentionPatterns` or the agent's `groupChat.mentionPatterns`). Patterns that core derives from the agent's name are not used in MAX — only explicitly configured ones. `channels.max.mentionPatterns` limits where patterns apply: `{ "mode": "deny" }` turns them off for MAX, `allowIn` / `denyIn` list group ids. A captionless voice message in such a group is checked against the patterns using the MAX transcript or one transcription by core (only for admitted groups and senders).

**Approvals and questions.** Approval buttons can be pressed only by senders listed explicitly in `allowFrom`; for `ask_user` questions a `"*"` entry is enough — in a group such an answer also needs the group admitted and the sender on its sender list (`groups.<id>.allowFrom` / `groupAllowFrom`), if it has one.

**Finding a user id.** `openclaw pairing list max` shows the id of a sender waiting for pairing. Group chat ids are negative numbers.

A named account that inherits an `open` policy logs a warning at start with the option path to set. Mind that inheritance when adding a second bot.

## `message` tool actions and their scope

Actions: `send`, `sendAttachment`, `sticker`, `edit`, `delete`, `pin`, `unpin`.

Targets: `user:<id>` for a private dialog, a numeric chat id for a group or channel (for example `-70000000000001`). `@username` and max.ru links are not supported by the MAX Bot API and are rejected with a clear error. A bare positive number that MAX answers with `dialog.not.found` is retried once as a user id.

```
message(action="send", target="user:12345678", message="Hello")
message(action="send", target="CHAT_ID", message="Choose:",
        buttons=[[{"text":"Yes","type":"callback","payload":"yes"},
                  {"text":"More","type":"message"}]])
message(action="sendAttachment", target="CHAT_ID", path="report.pdf", caption="Report")
message(action="sendAttachment", target="CHAT_ID", buffer="data:text/plain;base64,SGVsbG8=", filename="hello.txt")
message(action="send", target="CHAT_ID", path="reply.ogg", asVoice=true)
message(action="send", target="CHAT_ID", message="Quiet", silent=true)
message(action="sendAttachment", target="CHAT_ID", type="location", latitude="55.75", longitude="37.62")
message(action="sendAttachment", target="CHAT_ID", type="contact", contactName="Name", vcfPhone="+70000000000")
message(action="sticker", target="CHAT_ID", stickerId="CODE")
message(action="pin", target="CHAT_ID", messageId="MID")
```

- `attachments=[…]` sends several files; images and videos go as albums of up to 12, audio and files one by one. The result has `messageIds`; failed items are listed in `mediaErrors`.
- `silent=true` sends without a push notification; MAX channels always notify.
- `pin=true` or `delivery.pin` pins the sent message. MAX has no pinning in private dialogs: the plugin skips the call and returns `pinned: false` with a reason.

**Scope (`actionScope`).** In a turn started by someone other than the owner, actions work only in the current chat and in chats the inbound policy admits (dialogs with senders in `allowFrom` or paired, groups in `groups` and, when a group has a sender list, only if the requester is on it). Only calls OpenClaw marks as the owner's (`senderIsOwner: true`) are not limited: the owner's own turns, `openclaw message` from the CLI, an admin's chat in the Control UI. Every other call — including runs without a conversation whose owner mark is missing or false, as heartbeat, subagent, scheduled and plugin- or hook-started runs may be — is limited to the admitted chats; in a group with a sender list it is refused, as there is no requester to check. Core deliveries (agent replies, reminders, automation announcements) do not go through the `message` tool and are not affected. A `send` with `presentation` (cards, buttons), which core delivers without the plugin's action handler, is checked the same way, and `actions.send: false` applies to it too. The current chat counts only for the account the turn came through: an action in it through another MAX account (`accountId`) is checked against that account's policy. A refused action is a tool error raised before anything changes in MAX; if the plugin cannot determine the chat of a message, it refuses. Outside the chat of the current turn, `edit` and `delete` work only on messages the bot sent itself (the author comes from the same lookup as the chat); in the current chat and for the owner they work as before. A `send`, `sendAttachment` or `sticker` with `replyTo` (and a `send` with `presentation`) may reply only to a message of the chat it goes to (checked with one lookup, made only when `replyTo` is set); a reply to a message of another chat, or one whose chat cannot be determined, is refused.

- `admitted` (default) — as above.
- `current` — non-owner turns act only in their own chat.
- `off` — no check by the plugin (0.7 behaviour).

This stops a prompt injection in one chat from editing, deleting or posting in another.

## Media and local files

- **Incoming** media is downloaded after the access checks, within `mediaMaxMb` (default 20 MB) and `mediaMaxCount` (default 12 per message); the agent gets a note about media that was not loaded. Files are stored by OpenClaw core's media store.
- **Outgoing local files** are read only through the OpenClaw SDK loader from the directories core allows for the agent: its workspace, the gateway media directories and what the core filesystem policy permits. Paths outside them — including via `..` or symbolic links — fail with `Local media path is not under an allowed directory: …`. To send a file from elsewhere, copy it into the agent workspace first. When core policy grants the agent host reads, the directory is not limited, but core checks the type by content: images, audio, video, PDF, Office documents, archives and plain-text documents (`.txt`, `.md`, `.csv`, `.json`, `.yaml`) are sent, anything else fails with `Host-local media sends only allow …`. There is no option to turn these checks off.
- **Inline content:** `buffer` (base64 or a data URL) with `filename` and `contentType`; the size limit is checked before decoding. If both a path and `buffer` are given, the path is used.
- **Remote URLs** are fetched through core's SSRF-guarded downloader into memory. An image URL is passed to MAX as a link only when its host is public https; otherwise the image is downloaded and uploaded.

## Voice

**Incoming voice messages** are passed to OpenClaw core as audio media. If MAX supplied a transcript, the agent gets it as `[Voice transcript: …]` and core does not transcribe again; otherwise core transcribes the audio with the provider configured in `tools.media.audio`. A voice message that could not be downloaded and has no transcript reaches the agent as `[Voice message: audio unavailable, no transcript]`.

**Voice replies.** The channel tells core it accepts audio files (`mp3`, `m4a`, `wav`, `ogg`, `opus`) for TTS. When a reply is marked as voice — core TTS (for example `/tts`), the `[[audio_as_voice]]` directive or `asVoice=true` on `send` / `sendAttachment` — the audio goes out as a MAX `audio` attachment; the Bot API has no separate voice-note type. The reply text is delivered once, as a separate message. If MAX rejects the audio, the same bytes are sent as a file.

## Commands and menus

- `channels.max.commands` registers the bot's command list in MAX (`PATCH /me/commands`) at account start: up to 32 commands.
- A message starting with `/` is handled as an OpenClaw command.
- Commands for which core defines choices — `/think`, `/fast`, `/reasoning`, `/verbose`, `/usage`, `/elevated`, `/trace`, `/activation`, `/send`, `/tts`, `/session`, `/subagents`, `/acp`, `/tools` — sent without an argument answer with a menu of buttons; the current choice is marked ✓. A press applies the command exactly like typing `/think high`. Menus and presses are available only to senders allowed to run commands.
- A bot start from a deep link (`max.ru/<bot>?start=<payload>`) reaches the agent as `/start <payload>`.

## Turn status

With core's progress streaming, one status message shows what the agent is doing (status line, plan, approval requests and, with `toolProgress`, tool lines). It is edited at most once per second, sent without a notification and deleted after the answer is delivered. It is off by default.

```jsonc
"channels": { "max": { "streaming": { "mode": "progress", "progress": { "toolProgress": true } } } }
```

Other `streaming.progress` keys (`label`, `labels`, `maxLines`, `maxLineChars`, `commandText`) are core settings. If status sending fails, only the status stops; the turn is not affected.

## Multiple accounts and inheritance

Several MAX bots can run from one gateway. The top-level `channels.max` is the default account; named accounts live under `accounts`:

```jsonc
{
  "channels": {
    "max": {
      "tokenFile": "/home/you/.openclaw/secrets/max-main-token",
      "dmPolicy": "allowlist",
      "allowFrom": ["12345678"],
      "maxEventAgeMinutes": 30,
      "accounts": {
        "support": {
          "tokenFile": "/home/you/.openclaw/secrets/max-support-token",
          "dmPolicy": "open",
          "allowFrom": ["*"]
          // inherits maxEventAgeMinutes, groupPolicy, groups, … from channels.max
        }
      }
    }
  }
}
```

A named account takes every option it does not set from the channel level, including access policies and lists; its own value wins, and lists and `groups` are replaced as a whole. Own options are not inherited: `botToken`, `tokenFile`, `name`, `transport`, `webhookUrl`, `webhookSecret`, `webhookSecretFile`, `webhookPath`. `channels.max.enabled: false` disables every account; `accounts.<id>.enabled: false` disables one. `MAX_BOT_TOKEN` applies to the top-level account only.

Select an account from the CLI with `--account`: `openclaw message send --channel max --account support --target user:87654321 --message "Hi"`.

## Proxy, API address and the Russian Trusted CA

- **`httpProxy`** (for example `http://proxy.example.com:3128`, credentials allowed) routes all MAX traffic of the account through an HTTP(S) proxy: Bot API calls, uploads, and downloads of incoming attachments and remote media. Loopback addresses bypass it. Proxy credentials never appear in logs or errors; the start log shows `http://***@host:port`.
- **`apiBaseUrl`** points the plugin at another Bot API address, such as a test stand; the path prefix is kept. Only `https` is accepted (`http` only for loopback), so the token is never sent in clear text.
- An invalid value of either option stops the account at start with an error naming the option.
- **Russian Trusted CA.** Since July 2026 the Bot API at `platform-api2.max.ru` uses a certificate issued by the Russian Trusted Sub CA of the Ministry of Digital Development (Минцифры), which is not in Node.js's default trust store. The plugin ships the Russian Trusted Root CA and Sub CA certificates (`src/russian-trusted-ca.ts`) and adds them, next to the system CAs, only to its own connections to MAX — also inside a proxy tunnel. The process-wide trust store is not changed and `NODE_EXTRA_CA_CERTS` is not needed.

## Secrets and SecretRef

`botToken`, `webhookSecret` and `httpProxy` accept a plain string or an OpenClaw SecretRef:

```jsonc
"botToken": { "source": "env", "provider": "default", "id": "MAX_BOT_TOKEN" }
```

The provider must exist in core's `secrets.providers`. The paths `channels.max.botToken`, `webhookSecret`, `httpProxy` (and their `accounts.<id>` forms) are visible to `openclaw secrets configure`, `apply` and `audit`. The gateway resolves references before the account starts. An account whose reference does not resolve does not start — the error names the option and the reference, without its value and without falling back to `tokenFile` or `MAX_BOT_TOKEN`; other accounts keep running. `openclaw secrets audit` reports a token, webhook secret or proxy written as a plain string in `openclaw.json`.

`tokenFile` and `webhookSecretFile` remain supported. `openclaw channels status` shows `tokenSource` (`config`, `file`, `env`, `none`) and `tokenStatus` (`available`, `configured_unavailable`, `missing`) without the token.

## Reliability

- **Durable webhook queue.** Each accepted webhook event is written to `<stateDir>/max/inbox-<account>/` before MAX gets `200`. After a restart or crash, unprocessed events are handled first, in the original order within each chat. An event is finished once core has accepted the agent turn (core resumes an interrupted turn itself). If the event cannot be written or the queue is full (`webhookQueue.maxPending`), MAX gets `503` and retries later (`overflow: "drop"` acknowledges and drops instead). If the state directory is not writable, the queue falls back to memory with a warning. The SDK's own ingress queue is available only to bundled and official plugins in OpenClaw 2026.9.x, so the plugin keeps its own journal with the same contract.
- **Deduplication.** Keys of handled events (`update_type:timestamp:mid`; for events without a message — the chat and user instead of `mid`) are kept for 24 hours, up to 5000, and survive restarts, so MAX redeliveries are dropped. Long polling uses the same keys and, like the webhook queue, marks an event handled once core has accepted its turn: after a restart or crash in the middle of a batch — even in the middle of a turn — handled events are not repeated, and core resumes an interrupted turn instead of it being started again.
- **Gateway shutdown.** While the gateway stops or restarts gracefully, core accepts no new agent turns, but the webhook and long polling keep receiving events. Such an event is not lost: the plugin keeps it queued and retries after 2, 5, 10 and then every 30 seconds, with the chat's later events waiting behind it. If the gateway stops first, the event stays in the journal on disk and is handled after the start (long polling also does not save the batch marker). A refusal after core has accepted the turn and other processing errors are not retried. With the queue in memory (`webhookQueue.mode: "memory"` or an unwritable state directory) such an event is still skipped with an error in the log.
- **Event age.** Messages, edits, button presses and bot starts older than `maxEventAgeMinutes` (default 60) are skipped with a warning, so after a long outage the bot does not answer hours-old messages. Chat registry events are always processed.
- **Delivery errors** are reported to core: nothing sent → the reply is not dispatched; part visible → partial delivery with the visible message ids. After a failed text chunk the rest is not sent.
- **Long answers** are split at 4000 characters (or a lower `textChunkLimit`); with `streamMode: "partial"` the first chunk replaces the draft and the rest follow as new messages, buttons on the last one.
- **Answers in several parts.** When core delivers an answer as several parts, only the first goes into the streaming draft or answers the button press (`POST /answers`); the other parts, and the blocks of `streamMode: "block"`, follow as new messages, so no part overwrites another.
- **Streaming draft** (`streamMode: "partial"`). Draft updates are sent one at a time, so there is never a second draft; the final answer waits for a draft send already in flight. Tool output (verbose mode) goes as separate messages while the draft keeps streaming. A draft that did not become the answer — `NO_REPLY`, `/stop`, a reply via the `message` tool, or an answer of media only — is deleted at the end of the turn; after a processing error it stays.
- **Retries:** `429` and network errors are retried; `attachment.not.ready` after an upload is retried; text sends are throttled to MAX's 2 messages per second per chat.

## MAX API limits

From the MAX Bot API documentation:

| Limit | Value |
|---|---|
| Message text | 4000 characters (the plugin splits longer text) |
| Sending | 2 messages per second per dialog, group or channel (the plugin queues sends) |
| Editing | Only the bot's own messages. In dialogs: messages with an inline keyboard at any age, others within 7 days. In group chats and channels: any age. At most 2 edits per second per chat |
| Deleting | The bot needs admin rights with permission to delete. In dialogs only the bot's own messages, in groups and channels any. At most 2 deletions per second per chat |
| Album | Up to 12 images and videos per message; files and audio go separately |
| Buttons | Text ≤ 128 characters, payload ≤ 1024 bytes, ≤ 30 rows, ≤ 210 buttons |
| Bot commands | Up to 32 |
| Webhook | HTTPS on port 443, trusted certificate, `200` within 30 s; subscription removed after 8 hours of failed deliveries |
| Long polling | Not for production; unavailable while a webhook subscription exists |

## Security

- **Access control by default:** private messages need pairing, groups need an allowlist, group sender lists are enforced.
- **Action scope:** the `message` tool cannot act in chats the inbound policy does not admit (see [above](#message-tool-actions-and-their-scope)).
- **Local files:** only from directories OpenClaw allows for the agent; `..` and symbolic links cannot escape them. For an agent with host reads core allows any path, but only file types verified by content.
- **Remote media:** fetched through core's SSRF guard; private, loopback, link-local and metadata addresses are not passed to MAX as links.
- **Webhook:** the secret is checked in constant time before the body is read.
- **Secrets:** SecretRef support; token, webhook secret and proxy credentials are not logged.
- **TLS:** the extra Russian CAs are trusted only for the plugin's own connections.
- **Logs:** no message text by default.

**Proxy and internal addresses.** With `httpProxy` set, host names of the media the plugin downloads are resolved by the proxy, not by the plugin: literal private addresses and blocked host names are still refused, but a name that the proxy's DNS resolves to an internal address is fetched from the proxy's network. A proxy that sits inside an internal network therefore gives a path to that network's addresses. Use a proxy that has no access to internal resources.

**Known limitations.**

- If the disk fills up or becomes read-only while the gateway runs, the webhook answers `503` to every event and the bot does not answer until space is freed.
- In an admitted group, a captionless voice message that MAX has not transcribed is sent to speech-to-text to look for a mention of the bot. This is paid and not rate-limited; it happens only when mention patterns are configured (`groups.<id>.disableAudioPreflight` turns it off for a group).
- A button whose payload starts with `/` runs, when pressed, as a command from the person who pressed it, with that person's rights — as in core channels.
- An event whose processing crashes the gateway process (rather than raising an error the plugin catches) is processed again after every start until it is older than `maxEventAgeMinutes`; with `0`, without limit.
- `pin` and `unpin` check the chat but not the message author: in an admitted chat where the bot is an administrator they pin and unpin any message (unlike `edit` and `delete` outside the current chat).

Report vulnerabilities privately as described in [SECURITY.md](https://github.com/aspalagin/openclaw-max/blob/main/SECURITY.md). Supported version: 0.8.x.

## Privacy

What the plugin stores on disk (`<stateDir>` is OpenClaw's state directory, by default `~/.openclaw`):

| Path | Contents | Lifetime |
|---|---|---|
| `<stateDir>/max/state-<account>.json` | Long-polling marker; chat registry (chat id, type, title, when the bot was added, removed or stopped); the generated webhook secret, if any | Until deleted |
| `<stateDir>/max/inbox-<account>/` (directory `0700`, files `0600`) | Webhook events waiting to be processed, including message text and attachment metadata | Deleted once processed |
| `<stateDir>/max/inbox-<account>/completed.json` | Keys of handled events (`update_type:timestamp:mid`), no content | 24 hours, up to 5000 keys |

`webhookQueue.mode: "memory"` keeps pending webhook events in memory only (the key file stays). Downloaded incoming media and conversation history are stored by OpenClaw core, not by the plugin.

Logs: message type, text length, chat, message and user ids, errors and timings. Message text, captions and transcripts are not logged unless `logMessagePreview: true` (50-character preview at debug level). Tokens, secrets and proxy credentials are never logged.

Network access by the plugin: the MAX Bot API and its upload and CDN hosts (through `httpProxy` if set) and the hosts of remote media URLs the agent sends. When a voice message has no MAX transcript, OpenClaw core sends the audio to the speech-to-text provider configured in `tools.media.audio`.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| The bot does not answer in private messages | `dmPolicy` is `pairing` and the sender is not approved (`openclaw pairing list max`), or `allowlist` without the sender in `allowFrom` |
| The bot does not answer in a group | The chat is not in `groups` (`groupPolicy: allowlist`); the bot was not mentioned (`requireMention`); the sender is not in `groups.<id>.allowFrom` / `groupAllowFrom`; the bot is not a group administrator — MAX then does not deliver group messages to it (observed with long polling) |
| `MAX bot token not configured: …` in status | No `botToken`, `tokenFile` or `MAX_BOT_TOKEN`; the message names the option path. A `tokenFile` that is missing, empty or a symbolic link is not read (`tokenFile is missing, empty or not a regular file`); the default account then uses `MAX_BOT_TOKEN`, if set |
| Account does not start, error mentions a SecretRef | The reference did not resolve; check `secrets.providers` and the referenced variable, file or command |
| Webhook: no events arrive | Check the public URL, certificate and that the reverse proxy forwards the path; after 8 hours of failures MAX removes the subscription — the plugin recreates it within 12 minutes; long polling does not work while a subscription exists |
| MAX gets `503` from the webhook | The journal could not be written (disk full, permissions) or `webhookQueue.maxPending` was reached |
| Old messages get no answer after downtime | They are older than `maxEventAgeMinutes` (default 60); set `0` to answer any age |
| `Local media path is not under an allowed directory` | The file is outside the agent's allowed directories; copy it into the workspace |
| `Host-local media sends only allow …` | The agent has host reads and core did not recognize or does not allow the file type; send a file of an allowed type or pass the content as `buffer` |
| The `message` tool is refused in another chat | `actionScope`: the chat is not admitted by the inbound policy; add it to the policy or change `actionScope` |
| `MAX API does not resolve @username …` | Use `user:<id>` or a numeric chat id |
| `pinned: false` in a private dialog | MAX has no pinning in dialogs |
| Raw `**` or `_` in a message | MAX rejected the markup and the plugin resent the text as plain text |
| Account stops at start with a proxy or API URL error | `httpProxy` or `apiBaseUrl` is invalid, or `apiBaseUrl` uses `http` for a non-loopback host |
| `/think` answers with buttons instead of a text reply | Command menus: send `/think high` to set a value directly |
| Warning that an account inherits an open policy | A named account without its own `dmPolicy` / `groupPolicy` inherits `open`; set the policy in `accounts.<id>` |

## Upgrading from 0.7

A 0.7 config works without changes. Behaviour that changes and how to get the 0.7 behaviour back:

| Change in 0.8 | 0.7 behaviour |
|---|---|
| In a non-owner turn the `message` tool acts only in the current chat and in chats the inbound policy admits | `actionScope: "off"` (stricter: `"current"`) |
| A call without `senderIsOwner: true` (heartbeat, subagent, scheduled run without message authority) is limited to the admitted chats; in a group with a sender list it is refused | `actionScope: "off"` |
| Outside the chat of the current turn `edit` and `delete` touch only the bot's own messages | `actionScope: "off"` |
| `replyTo` of a send must point to a message of the chat the send goes to; otherwise it is refused | `actionScope: "off"` |
| Local files are read by core's guarded loader: from the agent's allowed directories, and with host reads only verified file types | No switch: copy files into the agent workspace |
| Messages, edits, button presses and bot starts older than 60 minutes — including MAX redeliveries after downtime — get no answer | `maxEventAgeMinutes: 0` |
| The webhook answers `200` after writing the event to disk; `503` when that fails or the queue is full | `webhookQueue.overflow: "drop"`, `webhookQueue.mode: "memory"` |
| Pending webhook events, with message text, are kept in `<stateDir>/max/inbox-<account>/` until processed | `webhookQueue.mode: "memory"` (the key file stays) |
| Named accounts inherit every channel-level option, including `dmPolicy`, `allowFrom`, `groupPolicy`, `groups` | Set the policies in each account |
| `channels.max.enabled: false` also disables named accounts | Keep the channel enabled; to run only named accounts, set no token at the top level (`botToken`, `tokenFile`, `MAX_BOT_TOKEN`) |
| A non-empty `groupAllowFrom` or `groups.<id>.allowFrom` limits who can talk to the bot in an admitted group | Remove the lists or add `"*"` |
| At most 12 media are downloaded from one incoming message | Raise `mediaMaxCount` |
| Forwarded messages start an agent turn (they were dropped) | — |
| Tool summaries (verbose mode) come without link previews | `disableLinkPreview: false` |
| `/think`, `/fast`, `/reasoning` and the other menu commands without an argument answer with buttons | — (with an argument they work as before) |
| Core `messages.groupChat.mentionPatterns`, if configured, now apply in MAX groups | `mentionPatterns: { "mode": "deny" }` |
| Core `silent` is honoured; the typing indicator follows core `typingMode` and lasts the whole turn | Core settings |
| After MAX rejects the markup, the answer arrives as plain text (visible `**`, `_`) | — |
| Debug logs carry no message text | `logMessagePreview: true` |
| `openclaw secrets audit` flags `botToken`, `webhookSecret` and `httpProxy` written as strings | Move them to a SecretRef, `tokenFile` or `webhookSecretFile` |
| `streaming.mode` wins over `streamMode` | Keep only one of them |
| Polling waits 2–60 s after an error (was 3 s), 5 minutes after `401` | — |
| The published package no longer contains `scripts/` | The scripts stay in the repository |
| `groups.<id>.enabled`, `groups.<id>.systemPrompt`, `groups.<id>.skills`, `actions` and `textChunkLimit` take effect (0.7 accepted them in the schema but did not read them) | Remove these keys from the config |

The full list is in the [changelog](https://github.com/aspalagin/openclaw-max/blob/main/CHANGELOG.md) (in Russian).

## Development

```bash
git clone https://github.com/aspalagin/openclaw-max.git
cd openclaw-max
npm ci
npm run typecheck      # run before build: build also emits on type errors
npm run build          # dist/index.js, dist/setup-entry.js, dist/secret-contract-api.js, dist/src/*.js
```

Checks, as in CI:

```bash
npm run format:check   # prettier
npm run lint           # eslint
npm run check:cycles   # import cycles between src/ modules
npm run typecheck
npm test               # vitest, including conformance with the MAX schema snapshot
npm audit --omit=dev --omit=peer   # runtime dependencies shipped with the package
```

CI also runs `typecheck` and the tests against `openclaw@latest` (with the locked and the minimum supported zod) and `openclaw@beta`; a failure on `beta` is reported but does not fail the build.

- `src/__fixtures__/max-schema-0.0.33.yaml` is a snapshot of the MAX Bot API schema; `npm run schema:update [ref]` refreshes it.
- `npm run test:api` calls the live API with `MAX_BOT_TOKEN` (`GET /me`, `GET /updates`); the helper scripts in `scripts/` are in the repository only, not in the package.
- Tests must use made-up tokens and ids.

Questions and proposals: [GitHub Issues](https://github.com/aspalagin/openclaw-max/issues). Contribution rules: [CONTRIBUTING.md](https://github.com/aspalagin/openclaw-max/blob/main/CONTRIBUTING.md).

## Acknowledgements, authors and license

**Acknowledgements.** Since 28 May 2026 (version 0.5.0 sync, commit `d8d24bc`) this plugin contains code derived from the `openclaw-max` 0.5.0 npm package by Evgeniy Bystrov, published under the MIT License (Copyright (c) 2026 Evgeniy Bystrov): [github.com/evgeniyvbystrov/openclaw-max](https://github.com/evgeniyvbystrov/openclaw-max). His copyright notice is kept in [LICENSE](LICENSE). Thank you.

**Authors.**

- [Petlevoy](https://github.com/petlevoy) — project founder.
- [Arseniy Palagin](https://github.com/aspalagin) — maintainer.

Development is carried out with the help of AI agents.

**License:** MIT, see [LICENSE](LICENSE).
