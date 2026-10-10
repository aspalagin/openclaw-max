/**
 * Tests for the MAX markdown dialect (format.ts): headings, highlight, quotes,
 * horizontal rules, tables in every markdown.tables mode, and text that must
 * stay as is (code, fenced blocks, URLs, mentions).
 */

import { describe, expect, it } from 'vitest';

import { resolveMaxTableMode, toMaxMarkdown } from './format.js';

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
  });

  it('converts headings and highlight around a table in one pass', () => {
    expect(
      toMaxMarkdown(`## Сводка\n\n| a | b |\n|---|---|\n| ==x== | 2 |`, { tableMode: 'bullets' }),
    ).toBe('# Сводка\n\n**^^x^^**\n• b: 2');
  });
});

describe('idempotence', () => {
  it('a second pass changes nothing, in every table mode', () => {
    const text = `## Итоги\n\n${TABLE}\n\n---\n\n==важно== <u>u</u>\n> цитата\n\n\`\`\`\n## код\n\`\`\``;
    for (const tableMode of ['bullets', 'code', 'block', 'off'] as const) {
      const once = toMaxMarkdown(text, { tableMode });
      expect(toMaxMarkdown(once, { tableMode })).toBe(once);
      expect(toMaxMarkdown(once)).toBe(once);
    }
  });
});

describe('resolveMaxTableMode', () => {
  it('defaults to bullets, maps block to code, keeps the rest', () => {
    expect(resolveMaxTableMode()).toBe('bullets');
    expect(resolveMaxTableMode({})).toBe('bullets');
    expect(resolveMaxTableMode({ markdown: {} })).toBe('bullets');
    expect(resolveMaxTableMode({ markdown: { tables: 'block' } })).toBe('code');
    expect(resolveMaxTableMode({ markdown: { tables: 'code' } })).toBe('code');
    expect(resolveMaxTableMode({ markdown: { tables: 'off' } })).toBe('off');
  });
});
