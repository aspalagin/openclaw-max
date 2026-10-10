/**
 * Tests for the MAX markdown dialect (format.ts): headings, highlight, quotes,
 * horizontal rules, tables in every markdown.tables mode (and by width when it
 * is not set), and text that must stay as is (code, fenced blocks, URLs, mentions).
 */

import { markdownToIRWithMeta } from 'openclaw/plugin-sdk/text-chunking';
import { describe, expect, it } from 'vitest';

import { codeTableWidth, displayWidth, resolveMaxTableMode, toMaxMarkdown } from './format.js';

const TABLE = [
  '| Модель | Цена | Комментарий |',
  '|---|---:|---|',
  '| **Opus** | 15 | для кода |',
  '| Haiku | 1 | `быстрая` |',
].join('\n');

describe('headings', () => {
  it('sends levels 2–6 as the one heading level MAX renders', () => {
    expect(toMaxMarkdown('## Итоги\nтекст')).toBe('# Итоги\nтекст');
    expect(toMaxMarkdown('### Три\n#### Четыре\n###### Шесть')).toBe('# Три\n# Четыре\n# Шесть');
    expect(toMaxMarkdown('   ## С отступом')).toBe('# С отступом');
    expect(toMaxMarkdown('текст\n\n## В середине ##\n')).toBe('текст\n\n# В середине ##\n');
  });

  it('keeps level 1, hashtags, seven hashes and indented code', () => {
    for (const text of [
      '# Заголовок',
      '#хештег в начале',
      'а тут ## не в начале',
      '####### семь',
      '    ## индентированный код',
      '##без пробела',
    ]) {
      expect(toMaxMarkdown(text)).toBe(text);
    }
  });
});

describe('highlight, underline, quotes', () => {
  it('turns ==text== into ^^text^^ and keeps ^^text^^', () => {
    expect(toMaxMarkdown('это ==важно== и ^^тоже^^')).toBe('это ^^важно^^ и ^^тоже^^');
    expect(toMaxMarkdown('**жирное ==выделение==**')).toBe('**жирное ^^выделение^^**');
  });

  it('leaves comparisons and padded markers alone', () => {
    for (const text of ['a == b == c', 'x==y==z', '== с пробелами ==', '===', 'a ==== b']) {
      expect(toMaxMarkdown(text)).toBe(text);
    }
  });

  it('turns <u>…</u> into ++…++ and keeps the other markers', () => {
    expect(toMaxMarkdown('<u>подчёркнуто</u>, __жирно__, ++уже++, ~~зачёркнуто~~')).toBe(
      '++подчёркнуто++, __жирно__, ++уже++, ~~зачёркнуто~~',
    );
  });

  it('keeps quotes as MAX reads them', () => {
    const text = '> цитата\n> вторая строка с **жирным**\n\nпосле';
    expect(toMaxMarkdown(text)).toBe(text);
  });
});

describe('horizontal rules', () => {
  it('replaces every thematic break with a visible line', () => {
    expect(toMaxMarkdown('до\n\n---\n\nпосле')).toBe('до\n\n───\n\nпосле');
    expect(toMaxMarkdown('***\n___\n* * *\n- - -\n  ----  ')).toBe('───\n───\n───\n───\n───');
  });

  it('keeps a rule under a text line visible instead of a lost setext heading', () => {
    expect(toMaxMarkdown('Раздел\n---\nтекст')).toBe('Раздел\n───\nтекст');
  });

  it('leaves dashes that are no rule alone', () => {
    for (const text of ['--', '- пункт', '--- текст', '|---|---|', 'a\n===']) {
      expect(toMaxMarkdown(text)).toBe(text);
    }
  });
});

describe('code, fenced blocks, URLs and mentions stay as written', () => {
  it('does not touch fenced blocks (``` and ~~~, also in lists and quotes)', () => {
    const fenced = [
      '```md',
      '## заголовок',
      '==x== <u>u</u>',
      '---',
      '```',
      '~~~',
      '### внутри тильд',
      '~~~',
      '- пункт',
      '  ```',
      '  ## в списке',
      '  ```',
      '> ```',
      '> ## в цитате',
      '> ```',
    ].join('\n');
    expect(toMaxMarkdown(fenced)).toBe(fenced);
    expect(toMaxMarkdown(`${fenced}\n## после`)).toBe(`${fenced}\n# после`);
  });

  it('a longer fence is closed only by a fence at least as long', () => {
    const text = '````\n```\n## внутри\n````\n## снаружи';
    expect(toMaxMarkdown(text)).toBe('````\n```\n## внутри\n````\n# снаружи');
  });

  it('an unclosed fence (a stream draft) protects the rest of the text', () => {
    expect(toMaxMarkdown('## Код\n```\n## ещё код\n---')).toBe('# Код\n```\n## ещё код\n---');
  });

  it('does not touch inline code, URLs and mentions', () => {
    const text =
      '`==x==` `<u>u</u>` https://example.com/?q==x==&a=<u>b</u> [Иван](max://user/42) [док](https://dev.max.ru/docs)';
    expect(toMaxMarkdown(text)).toBe(text);
  });
});

describe('tables (markdown.tables)', () => {
  it('bullets: the bold first cell, a bullet per other cell', () => {
    expect(toMaxMarkdown(`Итоги:\n\n${TABLE}\n\nПосле.`, { tableMode: 'bullets' })).toBe(
      [
        'Итоги:',
        '',
        '****Opus****',
        '• Цена: 15',
        '• Комментарий: для кода',
        '',
        '**Haiku**',
        '• Цена: 1',
        '• Комментарий: `быстрая`',
        '',
        'После.',
      ].join('\n'),
    );
  });

  it('code: an aligned monospace block; block falls back to code', () => {
    const code = [
      '```',
      '| Модель | Цена | Комментарий |',
      '| ------ | ---- | ----------- |',
      '| Opus   | 15   | для кода    |',
      '| Haiku  | 1    | быстрая     |',
      '```',
    ].join('\n');
    expect(toMaxMarkdown(TABLE, { tableMode: 'code' })).toBe(code);
    expect(toMaxMarkdown(TABLE, { tableMode: 'block' })).toBe(code);
  });

  it('off, or no mode at all: the table goes as written', () => {
    expect(toMaxMarkdown(TABLE, { tableMode: 'off' })).toBe(TABLE);
    expect(toMaxMarkdown(TABLE)).toBe(TABLE);
  });

  it('leaves a table inside a fenced block alone', () => {
    const text = `\`\`\`\n${TABLE}\n\`\`\``;
    expect(toMaxMarkdown(text, { tableMode: 'bullets' })).toBe(text);
    expect(toMaxMarkdown(text, { tableMode: 'code' })).toBe(text);
    expect(toMaxMarkdown(text, { tableMode: 'auto' })).toBe(text);
  });

  it('converts headings and highlight around a table in one pass', () => {
    expect(
      toMaxMarkdown(`## Сводка\n\n| a | b |\n|---|---|\n| ==x== | 2 |`, { tableMode: 'bullets' }),
    ).toBe('# Сводка\n\n**^^x^^**\n• b: 2');
  });
});

/** 27 columns as a monospace block. */
const NARROW = [
  '| Модель | Цена | Окно |',
  '|---|---|---|',
  '| Opus 5.5 | $15 | 1M |',
  '| GPT-6 | $10 | 400K |',
].join('\n');
const NARROW_CODE = [
  '```',
  '| Модель   | Цена | Окно |',
  '| -------- | ---- | ---- |',
  '| Opus 5.5 | $15  | 1M   |',
  '| GPT-6    | $10  | 400K |',
  '```',
].join('\n');
const NARROW_BULLETS =
  '**Opus 5.5**\n• Цена: $15\n• Окно: 1M\n\n**GPT-6**\n• Цена: $10\n• Окно: 400K';
/** 53 columns as a monospace block. */
const WIDE = [
  '| День | План | Где поесть |',
  '|---|---|---|',
  '| Суббота | Кремль и Кул-Шариф | Чак-чак на Баумана |',
].join('\n');
const WIDE_BULLETS = '**Суббота**\n• План: Кремль и Кул-Шариф\n• Где поесть: Чак-чак на Баумана';
/** `| Параметр | Значение |` with one row: 1 + (8 + 3) + (value + 3) = value + 15 columns. */
const sized = (value: string) => `| Параметр | Значение |\n|---|---|\n| x | ${value} |`;

describe('tables by width when markdown.tables is not set (auto)', () => {
  it('a narrow table goes as a monospace block', () => {
    expect(toMaxMarkdown(NARROW, { tableMode: 'auto' })).toBe(NARROW_CODE);
  });

  it('a wide table goes as bullets', () => {
    expect(toMaxMarkdown(WIDE, { tableMode: 'auto' })).toBe(WIDE_BULLETS);
  });

  it('picks the mode for every table of a text on its own', () => {
    const text = `## Сравнение\n\n${NARROW}\n\nМаршрут:\n\n${WIDE}\n\n${NARROW}\n\nИтог.`;
    expect(toMaxMarkdown(text, { tableMode: 'auto' })).toBe(
      `# Сравнение\n\n${NARROW_CODE}\n\nМаршрут:\n\n${WIDE_BULLETS}\n\n${NARROW_CODE}\n\nИтог.`,
    );
  });

  it('36 columns is still a block, 37 is bullets', () => {
    expect(codeTableWidth(['Параметр', 'Значение'], [['x', 'а'.repeat(21)]])).toBe(36);
    expect(toMaxMarkdown(sized('а'.repeat(21)), { tableMode: 'auto' })).toMatch(/^```\n/);
    expect(toMaxMarkdown(sized('а'.repeat(22)), { tableMode: 'auto' })).toBe(
      `**x**\n• Значение: ${'а'.repeat(22)}`,
    );
  });

  it('counts Cyrillic and Latin as one column, emoji and CJK as two', () => {
    expect(displayWidth('Привет, world')).toBe(13);
    expect(displayWidth('🔥')).toBe(2);
    expect(displayWidth('👍🏽')).toBe(2);
    expect(displayWidth('❤\uFE0F')).toBe(2);
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('е\u0301')).toBe(1);
    expect(displayWidth('©')).toBe(1);
    // 10 emoji and a letter: 21 columns, 36 in all; 11 emoji: 22 and 37
    expect(toMaxMarkdown(sized(`${'🔥'.repeat(10)}а`), { tableMode: 'auto' })).toMatch(/^```\n/);
    expect(toMaxMarkdown(sized('🔥'.repeat(11)), { tableMode: 'auto' })).toMatch(/^\*\*x\*\*\n/);
  });

  it("measures the width of core's monospace block", () => {
    for (const table of [NARROW, WIDE, TABLE, sized('🔥'.repeat(11))]) {
      const [{ headers, rows }] = markdownToIRWithMeta(table, { tableMode: 'block' }).tables;
      const lines = toMaxMarkdown(table, { tableMode: 'code' }).split('\n').slice(1, -1);
      expect(Math.max(...lines.map(displayWidth))).toBe(codeTableWidth(headers, rows));
    }
  });

  it('leaves tables in a fenced block alone, also across its blank lines', () => {
    const fenced = `\`\`\`\n${NARROW}\n\n${WIDE}\n\`\`\``;
    expect(toMaxMarkdown(`${fenced}\n\n${NARROW}\n\n${WIDE}`, { tableMode: 'auto' })).toBe(
      `${fenced}\n\n${NARROW_CODE}\n\n${WIDE_BULLETS}`,
    );
  });

  it('a table nested deep in a list is not left raw next to a table of the other mode', () => {
    const nested = WIDE.split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
    const out = toMaxMarkdown(`${NARROW}\n\n- пункт\n  - вложенный\n\n${nested}`, {
      tableMode: 'auto',
    });
    expect(out.startsWith(NARROW_CODE)).toBe(true);
    expect(out).toContain('• План: Кремль и Кул-Шариф');
    expect(out).not.toContain('|---|');
  });
});

describe('an explicit markdown.tables works as in core, whatever the width', () => {
  it('code keeps a wide table as one block', () => {
    const out = toMaxMarkdown(WIDE, { tableMode: 'code' });
    expect(out).toMatch(/^```\n\| День +\| План/);
    expect(Math.max(...out.split('\n').map(displayWidth))).toBeGreaterThan(36);
  });

  it('bullets keeps a narrow table as bullets', () => {
    expect(toMaxMarkdown(NARROW, { tableMode: 'bullets' })).toBe(NARROW_BULLETS);
  });

  it('off sends narrow and wide tables as written', () => {
    const text = `${NARROW}\n\n${WIDE}`;
    expect(toMaxMarkdown(text, { tableMode: 'off' })).toBe(text);
  });
});

describe('idempotence', () => {
  it('a second pass changes nothing, in every table mode', () => {
    const text = `## Итоги\n\n${TABLE}\n\n${WIDE}\n\n---\n\n==важно== <u>u</u>\n> цитата\n\n\`\`\`\n## код\n\`\`\``;
    for (const tableMode of ['bullets', 'code', 'block', 'off', 'auto'] as const) {
      const once = toMaxMarkdown(text, { tableMode });
      expect(toMaxMarkdown(once, { tableMode })).toBe(once);
      expect(toMaxMarkdown(once)).toBe(once);
    }
  });
});

describe('resolveMaxTableMode', () => {
  it('is auto when not set, maps block to code, keeps the rest', () => {
    expect(resolveMaxTableMode()).toBe('auto');
    expect(resolveMaxTableMode({})).toBe('auto');
    expect(resolveMaxTableMode({ markdown: {} })).toBe('auto');
    expect(resolveMaxTableMode({ markdown: { tables: 'bullets' } })).toBe('bullets');
    expect(resolveMaxTableMode({ markdown: { tables: 'block' } })).toBe('code');
    expect(resolveMaxTableMode({ markdown: { tables: 'code' } })).toBe('code');
    expect(resolveMaxTableMode({ markdown: { tables: 'off' } })).toBe('off');
  });
});
