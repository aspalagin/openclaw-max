/**
 * Simple in-memory sticker code cache.
 * Stores the last received sticker code per chat, so the agent can
 * send it back without explicitly passing the code.
 */

const lastStickerByChat = new Map<string, string>();
const lastStickerGlobal: { code: string | null } = { code: null };

/**
 * Store a sticker code received from a chat.
 */
export function rememberStickerCode(chatId: string | number, code: string): void {
  const key = String(chatId);
  lastStickerByChat.set(key, code);
  lastStickerGlobal.code = code;
}

/**
 * Get the last sticker code for a chat, or the last global one.
 */
export function getLastStickerCode(chatId?: string | number): string | null {
  if (chatId != null) {
    const code = lastStickerByChat.get(String(chatId));
    if (code) return code;
  }
  return lastStickerGlobal.code;
}
