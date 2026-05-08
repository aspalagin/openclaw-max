/**
 * Конвертер форматирования OpenClaw/стандартный markdown → MAX markdown.
 *
 * Отличия MAX markdown от стандартного:
 * - Подчёркивание: ++text++ (не __text__)
 * - Упоминание: [Имя](max://user/user_id)
 * - Остальное (bold, italic, strikethrough, code, links) — совпадает
 */

/**
 * Конвертирует OpenClaw/стандартный markdown в MAX markdown.
 * - __underline__ → ++underline++
 * - <u>underline</u> → ++underline++
 */
export function toMaxMarkdown(text: string): string {
  // __text__ → ++text++ (подчёркивание, не bold — bold это **)
  let result = text.replace(/__(.*?)__/g, "++$1++");
  // <u>text</u> → ++text++
  result = result.replace(/<u>(.*?)<\/u>/gi, "++$1++");
  return result;
}
