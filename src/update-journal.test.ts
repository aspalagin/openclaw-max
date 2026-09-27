/**
 * Tests for the durable update journal: entries survive a "restart" (a new
 * journal over the same directory), tombstones dedupe across restarts,
 * damaged rows and files never stop the journal, owner-only permissions.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MaxUpdate } from './api.js';
import { openMaxUpdateJournal, resetMaxUpdateJournalsForTest } from './update-journal.js';

const freshDir = () => path.join(mkdtempSync(path.join(tmpdir(), 'max-journal-')), 'inbox-a');

const update = (mid: string): MaxUpdate =>
  ({
    update_type: 'message_created',
    timestamp: 1000,
    message: { body: { mid, text: 'secret words' }, recipient: { chat_id: 7 } },
  }) as MaxUpdate;

/** A new process: nothing is cached, only the directory remains. */
const restart = () => resetMaxUpdateJournalsForTest();

afterEach(() => restart());

describe('MaxUpdateJournal', () => {
  it('keeps an appended update across a restart, owner-only on disk', async () => {
    const dir = freshDir();
    const first = await openMaxUpdateJournal({ accountId: 'a', dir });
    const entry = await first.append(update('m1'), 'k1');

    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    const file = path.join(dir, `u-${entry.seq}.json`);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    // The process holding it does not hand it out again.
    expect((await first.readPending()).entries).toEqual([]);

    restart();
    const second = await openMaxUpdateJournal({ accountId: 'a', dir });
    const { entries, unreadable } = await second.readPending();
    expect(unreadable).toBe(0);
    expect(entries.map((e) => e.update.message?.body?.mid)).toEqual(['m1']);
    // A redelivery of the pending update is a duplicate.
    expect(second.isDuplicate('k1')).toBe(true);
  });

  it('returns pending entries oldest first', async () => {
    const dir = freshDir();
    const journal = await openMaxUpdateJournal({ accountId: 'a', dir });
    for (const mid of ['m1', 'm2', 'm3']) await journal.append(update(mid), mid);
    restart();
    const { entries } = await (await openMaxUpdateJournal({ accountId: 'a', dir })).readPending();
    expect(entries.map((e) => e.key)).toEqual(['m1', 'm2', 'm3']);
  });

  it('deletes a completed entry and rejects its key after a restart until the TTL ends', async () => {
    const dir = freshDir();
    let now = 1_000_000;
    const clock = () => now;
    const journal = await openMaxUpdateJournal({ accountId: 'a', dir, now: clock });
    const entry = await journal.append(update('m1'), 'k1');
    await journal.complete(entry);
    expect(await fs.readdir(dir)).toEqual(['completed.json']);

    restart();
    const again = await openMaxUpdateJournal({
      accountId: 'a',
      dir,
      now: clock,
      completedTtlMs: 60_000,
    });
    expect(again.isDuplicate('k1')).toBe(true);
    expect((await again.readPending()).entries).toEqual([]);
    now += 60_001;
    expect(again.isDuplicate('k1')).toBe(false);
  });

  it('keeps at most completedMaxEntries keys, dropping the oldest', async () => {
    const dir = freshDir();
    let now = 1;
    const journal = await openMaxUpdateJournal({
      accountId: 'a',
      dir,
      now: () => now++,
      completedMaxEntries: 2,
    });
    for (const key of ['k1', 'k2', 'k3']) await journal.remember(key);
    expect(journal.hasCompleted('k1')).toBe(false);
    expect(journal.hasCompleted('k3')).toBe(true);
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'completed.json'), 'utf8'));
    expect(Object.keys(saved.keys)).toEqual(['k2', 'k3']);
  });

  it('skips and deletes a damaged entry, still returning the others', async () => {
    const dir = freshDir();
    const journal = await openMaxUpdateJournal({ accountId: 'a', dir });
    await journal.append(update('m1'), 'm1');
    await journal.append(update('m3'), 'm3');
    writeFileSync(path.join(dir, 'u-0000000000002-000000.json'), '{"v":1,"seq":');
    writeFileSync(path.join(dir, 'u-0000000000003-000000.json'), '{"v":2}');

    restart();
    const { entries, unreadable } = await (
      await openMaxUpdateJournal({ accountId: 'a', dir })
    ).readPending();
    expect(unreadable).toBe(2);
    expect(entries.map((e) => e.key)).toEqual(['m1', 'm3']);
    expect((await fs.readdir(dir)).filter((n) => n.includes('00000000000'))).toEqual([]);
  });

  it('starts with no tombstones when completed.json is damaged, and warns', async () => {
    const dir = freshDir();
    await fs.mkdir(dir, { recursive: true });
    writeFileSync(path.join(dir, 'completed.json'), 'not json');
    const warn = vi.fn();
    const journal = await openMaxUpdateJournal({ accountId: 'a', dir, warn });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable completed.json'));
    const entry = await journal.append(update('m1'), 'k1');
    await journal.complete(entry);
    restart();
    expect((await openMaxUpdateJournal({ accountId: 'a', dir })).isDuplicate('k1')).toBe(true);
  });

  it('never writes update content to the log', async () => {
    const dir = freshDir();
    await fs.mkdir(dir, { recursive: true });
    writeFileSync(path.join(dir, 'completed.json'), '[]');
    const warn = vi.fn();
    const journal = await openMaxUpdateJournal({ accountId: 'a', dir, warn });
    await journal.append(update('m1'), 'k1');
    restart();
    await (await openMaxUpdateJournal({ accountId: 'a', dir, warn })).readPending();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret words');
  });

  it('rejects opening a directory that cannot be created', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'max-journal-'));
    writeFileSync(path.join(base, 'file'), '');
    await expect(
      openMaxUpdateJournal({ accountId: 'a', dir: path.join(base, 'file', 'inbox') }),
    ).rejects.toThrow();
  });

  it('forgets a failed append so a redelivery is not a duplicate', async () => {
    const dir = freshDir();
    const journal = await openMaxUpdateJournal({ accountId: 'a', dir });
    // The directory vanished and a file took its place: every write fails.
    await fs.rm(dir, { recursive: true });
    writeFileSync(dir, '');
    await expect(journal.append(update('m1'), 'k1')).rejects.toThrow();
    expect(journal.isDuplicate('k1')).toBe(false);
  });
});
