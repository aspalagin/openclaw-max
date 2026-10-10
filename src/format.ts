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
 * - pipe-таблицы — штатным convertMarkdownTables ядра (меняет только диапазоны
 *   таблиц). Без `markdown.tables` (умолчание) каждая таблица по своей ширине:
 *   узкая — моноширинным блоком, широкая — пунктами. Явный режим — как в ядре:
 *   bullets — пункт на ячейку, code — моноширинный блок, block → code
 *   (нативных таблиц в MAX нет), off — как есть;
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

import { convertMarkdownTables, markdownToIRWithMeta } from 'openclaw/plugin-sdk/text-chunking';

/** channels.max.markdown.tables (и accounts.<id>.markdown.tables). */
export type MaxMarkdownTableMode = 'off' | 'bullets' | 'code' | 'block';

/** Режим таблиц для toMaxMarkdown: auto — markdown.tables не задан, режим по ширине таблицы. */
export type MaxTableMode = Exclude<MaxMarkdownTableMode, 'block'> | 'auto';

/**
 * Умолчание, которое видит ядро (messaging.defaultMarkdownTableMode). Режима
 * «по ширине» в MarkdownTableMode ядра нет, а ядро по этому значению решает
 * две вещи: добавлять ли в групповой промпт «Avoid Markdown tables» (да для
 * всего, кроме block/off) и что вернёт resolveMarkdownTableMode для MAX без
 * конфига. bullets: подсказка остаётся — нативных таблиц в MAX нет, широкая
 * таблица в группе станет длинным списком; а если кто-то сконвертирует текст
 * для MAX по этому ответу, пункты не развалятся на телефоне. block солгал бы
 * ядру о нативных таблицах, off — о сырых.
 */
export const MAX_DECLARED_TABLE_MODE: MaxMarkdownTableMode = 'bullets';

/**
 * Самая широкая таблица, которая без markdown.tables уходит моноширинным
 * блоком: ширина строки блока в колонках. Блок кода в MAX не прокручивается,
 * длинная строка переносится и таблица разваливается; на обычном телефоне
 * в блок влезает 34–38 моноширинных символов (демо 10.10.2026). Шире — пункты.
 */
export const MAX_NARROW_TABLE_WIDTH = 36;

/**
 * Режим таблиц аккаунта: accounts.<id> наследует channels.max.markdown
 * (accounts.ts). Не задан — auto; block → code: нативных таблиц в MAX нет.
 */
export function resolveMaxTableMode(config?: {
  markdown?: { tables?: MaxMarkdownTableMode };
}): MaxTableMode {
  const mode = config?.markdown?.tables;
  if (!mode) return 'auto';
  return mode === 'block' ? 'code' : mode;
}

const graphemes = new Intl.Segmenter();
const WIDE_GRAPHEME =
  /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u;
const ZERO_WIDTH_GRAPHEME = /^[\p{Mn}\p{Me}\p{Cf}]+$/u;

/** Ширина в моноширинных колонках: эмодзи и CJK — 2, метки и невидимые — 0, прочее — 1. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (WIDE_GRAPHEME.test(segment)) width += 2;
    else if (!ZERO_WIDTH_GRAPHEME.test(segment)) width += 1;
  }
  return width;
}

/** Ширина строки моноширинного блока таблицы, как его строит ядро: `| ячейка | … |`, колонка не уже 3. */
export function codeTableWidth(headers: string[], rows: string[][]): number {
  const widths: number[] = [];
  for (const row of [headers, ...rows]) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 3, displayWidth(cell));
    });
  }
  return widths.reduce((sum, width) => sum + width + 3, 1);
}

/** Режимы таблиц текста в auto: узкая — code, широкая — bullets. */
function autoTableModes(markdown: string): Set<'code' | 'bullets'> {
  if (!markdown.includes('|')) return new Set();
  const { tables } = markdownToIRWithMeta(markdown, {
    linkify: false,
    autolink: false,
    tableMode: 'block',
  });
  return new Set(
    tables.map((table) =>
      codeTableWidth(table.headers, table.rows) <= MAX_NARROW_TABLE_WIDTH ? 'code' : 'bullets',
    ),
  );
}

const CODE_OR_URL = /(```[\s\S]*?```|`[^`]*`|https?:\/\/\S+)/g;

/** Открывающая/закрывающая ограда блока кода, в том числе в списке или цитате. */
const FENCE = /^\s*(?:>\s*)*(`{3,}|~{3,})/;
const SUBHEADING = /^ {0,3}#{2,6}(?=[ \t])/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HORIZONTAL_RULE = '───';
const HIGHLIGHT = /(?<![\p{L}\p{N}_=])==(?=[^\s=])([^=\n]*?[^\s=])==(?![\p{L}\p{N}_=])/gu;

/** Открытая ограда ```/~~~ блока после строки `line`; undefined — вне блока. */
function fenceAfter(line: string, fence: string | undefined): string | undefined {
  const match = FENCE.exec(line);
  if (!fence) return match?.[1];
  const closes =
    match &&
    match[1][0] === fence[0] &&
    match[1].length >= fence.length &&
    !line.slice(match[0].length).trim();
  return closes ? undefined : fence;
}

/** Заголовки уровней 2–6 и горизонтальные линии; строки внутри ```/~~~ блоков не трогаются. */
function convertBlocks(text: string): string {
  let fence: string | undefined;
  return text
    .split('\n')
    .map((line) => {
      const inFence = fence !== undefined;
      fence = fenceAfter(line, fence);
      if (inFence || fence) return line;
      if (THEMATIC_BREAK.test(line)) return HORIZONTAL_RULE;
      return line.replace(SUBHEADING, '#');
    })
    .join('\n');
}

/** Куски текста до пустой строки вне ```/~~~ блоков включительно; join('') возвращает текст. */
function splitAtBlankLines(text: string): string[] {
  const blocks: string[] = [];
  let block = '';
  let fence: string | undefined;
  for (const line of text.split(/(?<=\n)/)) {
    block += line;
    fence = fenceAfter(line, fence);
    if (!fence && !line.trim()) {
      blocks.push(block);
      block = '';
    }
  }
  return block ? [...blocks, block] : blocks;
}

/** auto: каждая таблица по ширине — узкая моноширинным блоком, широкая пунктами. */
function convertTablesAuto(text: string): string {
  const modes = autoTableModes(text);
  if (modes.size < 2) {
    const [mode] = modes;
    return mode ? convertMarkdownTables(text, mode) : text;
  }
  // convertMarkdownTables задаёт один режим на весь текст, поэтому разные
  // таблицы конвертируются по кускам между пустыми строками: пустая строка
  // таблицу завершает. Таблицу, которую кусок без контекста не распознал
  // (глубоко вложенный список), добирает последний проход пунктами — готовые
  // блоки и пункты он не трогает.
  const converted = splitAtBlankLines(text)
    .map((block) =>
      convertMarkdownTables(block, autoTableModes(block).has('bullets') ? 'bullets' : 'code'),
    )
    .join('');
  return convertMarkdownTables(converted, 'bullets');
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
  options: { tableMode?: MaxMarkdownTableMode | 'auto' } = {},
): string {
  if (!text) return text;
  const { tableMode } = options;
  const withTables =
    tableMode === 'auto'
      ? convertTablesAuto(text)
      : tableMode && tableMode !== 'off'
        ? convertMarkdownTables(text, tableMode === 'block' ? 'code' : tableMode)
        : text;
  // split с захватывающей группой: нечётные индексы — код/URL (не трогаем)
  return convertBlocks(withTables)
    .split(CODE_OR_URL)
    .map((segment, index) => (index % 2 === 0 ? convertSegment(segment) : segment))
    .join('');
}
