/**
 * Конвертер форматирования OpenClaw/стандартный markdown → MAX markdown.
 *
 * Отличия MAX markdown от стандартного:
 * - Подчёркивание: MAX не поддерживает markdown-синтаксис подчёркивания, но
 *   рендерит HTML-тег <u>…</u> → конвертируем в ++…++.
 * - `**bold**` и `__bold__` MAX рендерит как жирный сам — НЕ трогаем.
 * - Упоминание: [Имя](max://user/user_id) — синтаксис MAX, оставляем как есть.
 * - bold, italic, strikethrough, code, ссылки — совпадают со стандартом.
 *
 * Конвертация выполняется только ВНЕ inline-кода, fenced-блоков и URL, чтобы
 * не портить текст внутри `код` / ```блоков``` / ссылок.
 */

const CODE_OR_URL = /(```[\s\S]*?```|`[^`]*`|https?:\/\/\S+)/g;

/** Заменяет только <u>…</u> → ++…++; markdown-подчёркивание MAX не поддерживает. */
function convertSegment(text: string): string {
  return text.replace(/<u>([\s\S]*?)<\/u>/gi, "++$1++");
}

/**
 * Конвертирует OpenClaw/стандартный markdown в MAX markdown, не затрагивая
 * содержимое inline-кода, fenced-блоков и URL.
 */
export function toMaxMarkdown(text: string): string {
  if (!text) return text;
  // split с захватывающей группой: нечётные индексы — код/URL (не трогаем)
  return text
    .split(CODE_OR_URL)
    .map((segment, index) => (index % 2 === 0 ? convertSegment(segment) : segment))
    .join("");
}
