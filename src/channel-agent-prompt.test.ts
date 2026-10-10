/**
 * Tests for the MAX message-tool hints: 0.8 capabilities are described and no
 * installation-specific data leaks into the prompt.
 */

import { describe, expect, it } from 'vitest';

import { maxAgentPromptAdapter } from './channel-agent-prompt.js';

const hints = () =>
  (maxAgentPromptAdapter.messageToolHints as (params: unknown) => string[])({}).join('\n');

describe('MAX message tool hints', () => {
  it('describes voice, inline files, silent sends, local file roots and action scope', () => {
    const text = hints();
    for (const needle of [
      'asVoice=true',
      '`buffer`',
      'silent=true',
      'media roots',
      'actionScope',
    ]) {
      expect(text).toContain(needle);
    }
  });

  it('describes the MAX markup and the table conversion', () => {
    const text = hints();
    for (const needle of [
      '# Heading',
      '^^highlight^^',
      '> quote',
      '++underline++',
      'markdown.tables',
    ]) {
      expect(text).toContain(needle);
    }
  });

  it('carries no installation paths', () => {
    const text = hints();
    expect(text).not.toMatch(/projects\/openclaw-max|\/root\/|sticker-emoji-map/);
  });
});
