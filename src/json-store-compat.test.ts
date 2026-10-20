import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readJsonFileWithFallback } from './json-store-compat.js';

describe('readJsonFileWithFallback (local replacement for the 2026.9.x SDK helper)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'max-json-store-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the fallback with exists=false when the file is missing', async () => {
    const result = await readJsonFileWithFallback(path.join(dir, 'missing.json'), { a: 1 });
    expect(result).toEqual({ value: { a: 1 }, exists: false });
  });

  it('returns the parsed value with exists=true for valid JSON', async () => {
    const file = path.join(dir, 'valid.json');
    await writeFile(file, JSON.stringify({ keys: { x: 1 } }), 'utf8');
    const result = await readJsonFileWithFallback<{ keys: Record<string, number> } | null>(
      file,
      null,
    );
    expect(result).toEqual({ value: { keys: { x: 1 } }, exists: true });
  });

  it('returns the fallback with exists=true for unreadable JSON or a JSON null', async () => {
    const broken = path.join(dir, 'broken.json');
    await writeFile(broken, '{not json', 'utf8');
    expect(await readJsonFileWithFallback(broken, null)).toEqual({ value: null, exists: true });
    const nul = path.join(dir, 'null.json');
    await writeFile(nul, 'null', 'utf8');
    expect(await readJsonFileWithFallback(nul, { fallback: true })).toEqual({
      value: { fallback: true },
      exists: true,
    });
  });
});
