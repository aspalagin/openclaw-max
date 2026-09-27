/**
 * Durable journal of MAX updates: accepted webhook updates survive a gateway
 * restart or crash, and completion tombstones reject a redelivered update
 * across restarts (webhook and polling).
 *
 * Why a plugin-owned journal: the SDK's durable ingress
 * (createChannelIngressMonitor over runtime.state.openChannelIngressQueue) is
 * refused to plugins that are neither bundled nor trusted official installs
 * (PluginTrustRefusalError), and this plugin is neither. The journal follows
 * the same contract: append before the webhook ack, one row per event,
 * completion tombstones for replay dedupe, bounded retention.
 *
 * Layout: <stateDir>/max/inbox-<account>/ (0700)
 *   u-<seq>.json    one pending update (0600), deleted once handled
 *   completed.json  dedupe keys of handled updates with their completion time
 *
 * Update bodies are conversation content: they never reach the log.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { readJsonFileWithFallback, writeJsonFileAtomically } from 'openclaw/plugin-sdk/json-store';
import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths';

import type { MaxUpdate } from './api.js';

/** How long a handled update's key rejects a redelivery (MAX retries within 8 h). */
export const MAX_JOURNAL_COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
/** Most dedupe keys kept; the oldest go first. */
export const MAX_JOURNAL_COMPLETED_MAX_ENTRIES = 5000;
/** Unknown files (e.g. a temp file of a write cut by a crash) older than this are removed. */
const STRAY_FILE_MIN_AGE_MS = 60_000;

const ENTRY_FILE = /^u-(\d{13}-\d{6})\.json$/;
const COMPLETED_FILE = 'completed.json';

export type MaxJournalEntry = {
  v: 1;
  seq: string;
  receivedAt: number;
  key?: string;
  update: MaxUpdate;
};

type CompletedFile = { v: 1; keys: Record<string, number> };

export function resolveMaxJournalDir(accountId: string): string {
  const safeId = accountId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(resolveStateDir(), 'max', `inbox-${safeId}`);
}

export type MaxUpdateJournalOptions = {
  accountId: string;
  /** Default: resolveMaxJournalDir(accountId). */
  dir?: string;
  now?: () => number;
  completedTtlMs?: number;
  completedMaxEntries?: number;
  warn?: (message: string) => void;
};

/** One journal per directory in a process: overlapping account tasks share ownership. */
const openJournals = new Map<string, MaxUpdateJournal>();

/**
 * Open (or reuse) the journal of an account. Rejects when the directory cannot
 * be created or written; callers then fall back to the in-memory queue.
 */
export async function openMaxUpdateJournal(
  options: MaxUpdateJournalOptions,
): Promise<MaxUpdateJournal> {
  const dir = options.dir ?? resolveMaxJournalDir(options.accountId);
  const existing = openJournals.get(dir);
  if (existing) {
    if (options.warn) existing.warn = options.warn;
    return existing;
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  await fs.access(dir, fs.constants.W_OK);
  const journal = new MaxUpdateJournal(dir, options);
  await journal.loadCompleted();
  const raced = openJournals.get(dir);
  if (raced) return raced;
  openJournals.set(dir, journal);
  return journal;
}

export class MaxUpdateJournal {
  warn?: (message: string) => void;
  private readonly now: () => number;
  private readonly completedTtlMs: number;
  private readonly completedMaxEntries: number;
  /** Dedupe key → completion time, oldest first. */
  private readonly completed = new Map<string, number>();
  /** Entries this process holds (queued or dispatching): recovery skips them. */
  private readonly owned = new Set<string>();
  /** Keys of entries still on disk. */
  private readonly pendingKeys = new Set<string>();
  private lastSeqMs = 0;
  private seqCounter = 0;
  private scheduledWrite: Promise<void> | undefined;
  private lastWrite: Promise<void> = Promise.resolve();

  constructor(
    readonly dir: string,
    options: MaxUpdateJournalOptions,
  ) {
    this.warn = options.warn;
    this.now = options.now ?? Date.now;
    this.completedTtlMs = options.completedTtlMs ?? MAX_JOURNAL_COMPLETED_TTL_MS;
    this.completedMaxEntries = options.completedMaxEntries ?? MAX_JOURNAL_COMPLETED_MAX_ENTRIES;
  }

  /** @internal */
  async loadCompleted(): Promise<void> {
    const file = path.join(this.dir, COMPLETED_FILE);
    const { value, exists } = await readJsonFileWithFallback<CompletedFile | null>(file, null);
    const keys = value && typeof value === 'object' ? value.keys : undefined;
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
      if (exists)
        this.warn?.(`MAX journal ${this.dir}: unreadable ${COMPLETED_FILE}, starting empty`);
      return;
    }
    const entries = Object.entries(keys)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
      .sort((a, b) => a[1] - b[1]);
    for (const [key, at] of entries) this.completed.set(key, at);
    this.pruneCompleted();
  }

  /** True when the key belongs to a pending update or was handled within the TTL. */
  isDuplicate(key: string): boolean {
    return this.pendingKeys.has(key) || this.hasCompleted(key);
  }

  hasCompleted(key: string): boolean {
    const at = this.completed.get(key);
    return at !== undefined && this.now() - at < this.completedTtlMs;
  }

  /** Durably record an accepted update; resolves once it is on disk. */
  async append(update: MaxUpdate, key: string | undefined): Promise<MaxJournalEntry> {
    const receivedAt = this.now();
    const entry: MaxJournalEntry = {
      v: 1,
      seq: this.nextSeq(receivedAt),
      receivedAt,
      ...(key ? { key } : {}),
      update,
    };
    // Owned before the file exists, so a concurrent recovery never takes it.
    this.owned.add(entry.seq);
    if (key) this.pendingKeys.add(key);
    try {
      await writeJsonFileAtomically(this.entryPath(entry.seq), entry);
    } catch (err) {
      this.owned.delete(entry.seq);
      if (key) this.pendingKeys.delete(key);
      await fs.rm(this.entryPath(entry.seq), { force: true }).catch(() => undefined);
      throw err;
    }
    return entry;
  }

  /**
   * Entries on disk that this process does not hold (left by an earlier
   * process), oldest first. They become owned. Unreadable entries are deleted
   * and counted.
   */
  async readPending(): Promise<{ entries: MaxJournalEntry[]; unreadable: number }> {
    const names = await fs.readdir(this.dir);
    const entries: MaxJournalEntry[] = [];
    let unreadable = 0;
    for (const name of names.sort()) {
      const match = ENTRY_FILE.exec(name);
      if (!match) {
        await this.removeStray(name);
        continue;
      }
      const seq = match[1] as string;
      if (this.owned.has(seq)) continue;
      const file = this.entryPath(seq);
      const { value } = await readJsonFileWithFallback<unknown>(file, null);
      if (!isJournalEntry(value, seq)) {
        unreadable += 1;
        await fs.rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      this.owned.add(seq);
      if (value.key) this.pendingKeys.add(value.key);
      entries.push(value);
    }
    return { entries, unreadable };
  }

  /**
   * The update was handled (or deliberately skipped): remember its key, then
   * delete the entry. A failed tombstone write is logged, the entry is still
   * deleted — replaying a handled update on every start would be worse.
   */
  async complete(entry: MaxJournalEntry): Promise<void> {
    if (entry.key) await this.remember(entry.key);
    try {
      await fs.rm(this.entryPath(entry.seq), { force: true });
    } catch (err) {
      this.warn?.(`MAX journal: could not delete handled entry ${entry.seq}: ${errorCode(err)}`);
    }
    this.owned.delete(entry.seq);
    if (entry.key) this.pendingKeys.delete(entry.key);
  }

  /** Stop holding an entry without handling it: the next recovery takes it. */
  release(entry: MaxJournalEntry): void {
    this.owned.delete(entry.seq);
  }

  /** Record a handled update's key (polling uses this without an entry). */
  async remember(key: string): Promise<void> {
    this.completed.delete(key);
    this.completed.set(key, this.now());
    this.pruneCompleted();
    try {
      await this.saveCompleted();
    } catch (err) {
      this.warn?.(`MAX journal: could not save ${COMPLETED_FILE}: ${errorCode(err)}`);
    }
  }

  private pruneCompleted(): void {
    const cutoff = this.now() - this.completedTtlMs;
    for (const [key, at] of this.completed) {
      if (at > cutoff && this.completed.size <= this.completedMaxEntries) break;
      this.completed.delete(key);
    }
  }

  /** Coalesced, serialized writes: a caller resolves once a write with its change is done. */
  private saveCompleted(): Promise<void> {
    if (this.scheduledWrite) return this.scheduledWrite;
    const write = this.lastWrite
      .catch(() => undefined)
      .then(async () => {
        this.scheduledWrite = undefined;
        const file: CompletedFile = { v: 1, keys: Object.fromEntries(this.completed) };
        await writeJsonFileAtomically(path.join(this.dir, COMPLETED_FILE), file);
      });
    this.scheduledWrite = write;
    this.lastWrite = write;
    return write;
  }

  private async removeStray(name: string): Promise<void> {
    if (name === COMPLETED_FILE) return;
    const file = path.join(this.dir, name);
    try {
      const stat = await fs.lstat(file);
      if (stat.isFile() && this.now() - stat.mtimeMs > STRAY_FILE_MIN_AGE_MS) {
        await fs.rm(file, { force: true });
      }
    } catch {
      // Gone meanwhile or not ours to judge: leave it.
    }
  }

  private nextSeq(at: number): string {
    const ms = Math.max(at, this.lastSeqMs);
    this.seqCounter = ms === this.lastSeqMs ? this.seqCounter + 1 : 0;
    this.lastSeqMs = ms;
    return `${String(ms).padStart(13, '0')}-${String(this.seqCounter).padStart(6, '0')}`;
  }

  private entryPath(seq: string): string {
    return path.join(this.dir, `u-${seq}.json`);
  }
}

function isJournalEntry(value: unknown, seq: string): value is MaxJournalEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<MaxJournalEntry>;
  return (
    entry.v === 1 &&
    entry.seq === seq &&
    typeof entry.receivedAt === 'number' &&
    (entry.key === undefined || typeof entry.key === 'string') &&
    !!entry.update &&
    typeof entry.update === 'object' &&
    typeof (entry.update as { update_type?: unknown }).update_type === 'string'
  );
}

/** Error code only: messages of fs errors carry paths, never needed in logs here. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : String(err);
}

/** @internal test helper: forget cached journals. */
export function resetMaxUpdateJournalsForTest(): void {
  openJournals.clear();
}
