import { promises as fs } from 'node:fs';

/**
 * Local replacement for `readJsonFileWithFallback` from `openclaw/plugin-sdk/json-store`.
 * OpenClaw 2026.10.5 dropped that export (only `loadJsonFile`, `saveJsonFile` and
 * `writeJsonFileAtomically` remain), and a missing named export fails ESM linking for
 * the whole plugin. Semantics match the 2026.9.x helper: a missing file yields the
 * fallback with `exists: false`; an unreadable or invalid file yields the fallback with
 * `exists: true`, so callers can warn and start empty.
 */
export async function readJsonFileWithFallback<T>(
  filePath: string,
  fallback: T,
): Promise<{ value: T; exists: boolean }> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return { value: fallback, exists: code !== 'ENOENT' };
  }
  try {
    const parsed = JSON.parse(raw) as T | null;
    return parsed == null ? { value: fallback, exists: true } : { value: parsed, exists: true };
  } catch {
    return { value: fallback, exists: true };
  }
}
