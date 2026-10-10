/**
 * Конвертер форматирования OpenClaw/стандартный markdown → MAX markdown.
 *
 * Что MAX разбирает сам (живая проба 10.10.2026, body.markup из GET /messages):
 * `**`/`__` жирный, `*`/`_` курсив, `~~` зачёркнутый, `++` подчёркнутый,
 * `^^` выделение, `код` и ```блоки```, ссылки, упоминания
 * [Имя](max://user/user_id), `# заголовок` (один уровень; setext `===` тоже),
 * `> цитата` и экранирование `\`. Это НЕ трогаем.
 *
 * Что конвертируем (MAX показывает сырым или теряет):
 * - pipe-таблицы — по `markdown.tables` штатным convertMarkdownTables ядра
 *   (меняет только диапазоны таблиц): bullets — пункт на ячейку (умолчание),
 *   code — моноширинный блок, block → code (нативных таблиц в MAX нет),
 *   off — как есть;
 * - `##`…`######` → `#`: уровни 2–6 MAX снимает без разметки;
 * - горизонтальные линии `---`, `***`, `___` → `───`: MAX оставляет их сырыми,
 *   `* * *` превращает во вложенные списки, а `---` под строкой текста
 *   съедает вместе с её форматом (setext-заголовок второго уровня);
 * - `==текст==` → `^^текст^^`;
 * - `<u>…</u>` → `++…++`: подчёркивание тегом MAX в markdown не понимает.
 *
 * Заголовки и линии меняются только вне fenced-блоков, инлайн-замены — вне
 * inline-кода, fenced-блоков и URL. Повторный вызов ничего не меняет, поэтому
 * текст можно подготовить до разбиения на части, а send.ts пройдёт по каждой
 * части ещё раз.
 */

import { convertMarkdownTables } from 'openclaw/plugin-sdk/text-chunking';

/** channels.max.markdown.tables (и accounts.<id>.markdown.tables). */
export type MaxMarkdownTableMode = 'off' | 'bullets' | 'code' | 'block';

/** Умолчание: как у мобильных каналов ядра (Signal, WhatsApp). */
export const MAX_DEFAULT_TABLE_MODE: MaxMarkdownTableMode = 'bullets';

/**
 * Режим таблиц аккаунта: accounts.<id> наследует channels.max.markdown
 * (accounts.ts). block → code: нативных таблиц в MAX нет.
 */
export function resolveMaxTableMode(config?: {
  markdown?: { tables?: MaxMarkdownTableMode };
}): Exclude<MaxMarkdownTableMode, 'block'> {
  const mode = config?.markdown?.tables ?? MAX_DEFAULT_TABLE_MODE;
  return mode === 'block' ? 'code' : mode;
}

const CODE_OR_URL = /(```[\s\S]*?```|`[^`]*`|https?:\/\/\S+)/g;

/** Открывающая/закрывающая ограда блока кода, в том числе в списке или цитате. */
const FENCE = /^\s*(?:>\s*)*(`{3,}|~{3,})/;
const SUBHEADING = /^ {0,3}#{2,6}(?=[ \t])/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HORIZONTAL_RULE = '───';
const HIGHLIGHT = /(?<![\p{L}\p{N}_=])==(?=[^\s=])([^=\n]*?[^\s=])==(?![\p{L}\p{N}_=])/gu;

/** Заголовки уровней 2–6 и горизонтальные линии; строки внутри ```/~~~ блоков не трогаются. */
function convertBlocks(text: string): string {
  let fence: string | undefined;
  return text
    .split('\n')
    .map((line) => {
      const match = FENCE.exec(line);
      if (fence) {
        const closes =
          match &&
          match[1][0] === fence[0] &&
          match[1].length >= fence.length &&
          !line.slice(match[0].length).trim();
        if (closes) fence = undefined;
        return line;
      }
      if (match) {
        fence = match[1];
        return line;
      }
      if (THEMATIC_BREAK.test(line)) return HORIZONTAL_RULE;
      return line.replace(SUBHEADING, '#');
    })
    .join('\n');
}

/** Инлайн-замены сегмента вне кода и URL: <u>…</u> → ++…++, ==…== → ^^…^^. */
function convertSegment(text: string): string {
  return text.replace(/<u>([\s\S]*?)<\/u>/gi, '++$1++').replace(HIGHLIGHT, '^^$1^^');
}

/**
 * Конвертирует OpenClaw/стандартный markdown в MAX markdown, не затрагивая
 * содержимое inline-кода, fenced-блоков и URL. Таблицы конвертируются, только
 * если передан `tableMode` (режим аккаунта, resolveMaxTableMode).
 */
export function toMaxMarkdown(
  text: string,
  options: { tableMode?: MaxMarkdownTableMode } = {},
): string {
  if (!text) return text;
  const { tableMode } = options;
  const withTables =
    tableMode && tableMode !== 'off'
      ? convertMarkdownTables(text, tableMode === 'block' ? 'code' : tableMode)
      : text;
  // split с захватывающей группой: нечётные индексы — код/URL (не трогаем)
  return convertBlocks(withTables)
    .split(CODE_OR_URL)
    .map((segment, index) => (index % 2 === 0 ? convertSegment(segment) : segment))
    .join('');
}
