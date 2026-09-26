/**
 * Agent prompt hints of the MAX channel: stickers, location, contact, pin,
 * button types and presentation for the message tool.
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

    // Also try to load full sticker-emoji-map.json for extended catalog
    let extendedHint = '';
    try {
      const fs = require('fs');
      const path = require('path');
      const candidates = [
        path.join(__dirname, '..', 'sticker-emoji-map.json'),
        path.join(process.cwd(), 'projects', 'openclaw-max', 'sticker-emoji-map.json'),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          extendedHint = ' Full emoji→sticker map available at: ' + p;
          break;
        }
      }
    } catch {}

    return [
      '- MAX stickers: use `message(action="sticker", target="CHAT_ID", stickerId="CODE")`. Pick a sticker code matching the mood from the emoji map below. Each entry is emoji:hexCode.',
      `- Sticker emoji map: ${emojiMap}${extendedHint}`,
      '- MAX location: use `message(action="sendAttachment", target="CHAT_ID", type="location", latitude="55.75", longitude="37.62")` to send a native map pin.',
      '- MAX contact: use `message(action="sendAttachment", target="CHAT_ID", type="contact", contactName="Name", vcfPhone="+70001234567")` to send a native contact card.',
      '- MAX pin: use `message(action="pin", target="CHAT_ID", messageId="MID")` to pin a message; `message(action="unpin", target="CHAT_ID")` to unpin.',
      '- MAX buttons support types: callback (default), link, message (sends the button text as a user message — great for suggested replies), clipboard (copies payload), open_app (webApp = public name of the bot wired to the mini app), request_contact, request_geo_location. Pass via buttons=[[{"text":"...","type":"message"}]].',
      '- MAX rich messages: prefer `presentation` (title/tone, text, context, divider, table/chart as monospace text, buttons and select as an inline keyboard); `pin=true` pins the sent message.',
    ];
  },
};
