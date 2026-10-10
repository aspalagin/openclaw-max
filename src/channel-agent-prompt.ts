/**
 * Agent prompt hints of the MAX channel: text formatting, stickers, location,
 * contact, pin, button types, presentation, voice, inline files, silent sends,
 * local file roots and action scope for the message tool.
 */

import type { ChannelPlugin } from 'openclaw/plugin-sdk/channel-core';

import type { ResolvedMaxAccount } from './accounts.js';

type MaxChannelPlugin = ChannelPlugin<ResolvedMaxAccount>;

/** message tool hints for MAX-specific actions. */
export const maxAgentPromptAdapter: NonNullable<MaxChannelPlugin['agentPrompt']> = {
  messageToolHints: () => {
    // Compact sticker emoji map: top 50 emojis → sticker codes
    // Codes are hex IDs derived from listmax.ru external_id: parseInt(extId).toString(16)
    const emojiMap =
      '😂:109550b5 😊:109971b5 😍:10931eb5 🥰:10931eb5 😢:109330b5 😭:109330b5 😡:10941fb5 😱:109302b5 🤔:109308b5 👍:109368b5 👎:109323b5 ❤️:10931eb5 🔥:b4867ebb 💪:c1254bbb 🎉:10933cb5 😘:10931eb5 🤗:109b94b5 😎:10931db5 🙄:c14211bb 😴:10936eb5 😤:10941fb5 🤮:6b8bb 🤯:109302b5 😳:109302b5 🥳:10933cb5 💀:b4863ebb 🙈:b4850cbb 😏:11e4c60bb 😅:109550b5 🤣:109550b5 😋:109d2db5 😜:455b5 🤷:10d5cf5bb 😫:10936eb5 😩:10997db5 🥺:109356b5 😌:14aae3bb 😒:109323b5 🤪:455b5 😇:11e4dedbb 🙏:50cb5 💔:10997db5 👀:b48534bb ✨:11e43b2bb 😈:10941fb5 🤝:109368b5 🤦:502b5 😬:5dab4b5 🤩:5dabfb5 😶:2ae2b5';

    return [
      '- MAX formatting (replies and `send`): Markdown with **bold**, *italic*, ~~strike~~, ++underline++, ^^highlight^^ (red), `code`, ``` blocks, [links](https://example.com), `# Heading` (one level: `##`…`######` are sent as `#`) and `> quote`. MAX has no tables: Markdown tables are converted (by default each row becomes its bold first cell with a bullet per other cell; channels.max.markdown.tables=code makes a monospace block), so prefer lists for wide data.',
      '- MAX stickers: use `message(action="sticker", target="CHAT_ID", stickerId="CODE")`. Pick a sticker code matching the mood from the emoji map below. Each entry is emoji:hexCode.',
      `- Sticker emoji map: ${emojiMap}`,
      '- MAX location: use `message(action="sendAttachment", target="CHAT_ID", type="location", latitude="55.75", longitude="37.62")` to send a native map pin.',
      '- MAX contact: use `message(action="sendAttachment", target="CHAT_ID", type="contact", contactName="Name", vcfPhone="+70001234567")` to send a native contact card.',
      '- MAX pin: use `message(action="pin", target="CHAT_ID", messageId="MID")` to pin a message; `message(action="unpin", target="CHAT_ID")` to unpin.',
      '- MAX buttons support types: callback (default), link, message (sends the button text as a user message — great for suggested replies), clipboard (copies payload), open_app (webApp = public name of the bot wired to the mini app), request_contact, request_geo_location. Pass via buttons=[[{"text":"...","type":"message"}]].',
      '- MAX rich messages: prefer `presentation` (title/tone, text, context, divider, table/chart as monospace text, buttons and select as an inline keyboard); `pin=true` pins the sent message.',
      '- MAX voice: `asVoice=true` on `send`/`sendAttachment` with an audio file (mp3, m4a, wav, ogg, opus) sends it as a MAX audio message instead of a file.',
      '- MAX files without a path: `sendAttachment` takes `buffer` (base64 or a data URL) with `filename` and `contentType`.',
      '- MAX quiet sends: `silent=true` sends without a notification (MAX channels always notify).',
      '- MAX local files: only files under the media roots OpenClaw allows for this agent (its workspace and media directories) can be sent; a path outside them is refused — save the file there first.',
      "- MAX action scope: `send`, `sendAttachment`, `sticker`, `edit`, `delete`, `pin` and `unpin` work in the current chat and in chats the channel access policy admits, or on the owner's request (channels.max.actionScope). A refusal is a tool error: report it, do not retry in another chat.",
    ];
  },
};
