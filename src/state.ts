/**
 * Persistent per-account MAX state: long-polling marker + chat registry.
 *
 * The marker survives gateway restarts so updates are neither replayed nor
 * lost past the server-side retention window. The chat registry replaces the
 * deprecated GET /chats (June 2026): chats are collected from bot_added /
 * bot_started / chat_title_changed updates and passively from group messages.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

export interface MaxChatRegistryEntry {
  chatId: number;
  /** "chat" | "channel" | "dialog" */
  type?: string;
  title?: string;
  addedAt?: number;
  /** Set when bot_removed / dialog_removed arrives; cleared on re-add */
  removedAt?: number;
  /** bot_stopped in a dialog: user halted the bot */
  stopped?: boolean;
}

export interface MaxAccountState {
  marker?: number | null;
  chats?: Record<string, MaxChatRegistryEntry>;
}

export function resolveMaxStatePath(accountId: string): string {
  const safeId = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(resolveStateDir(), "max", `state-${safeId}.json`);
}

export async function loadMaxAccountState(accountId: string): Promise<MaxAccountState> {
  const { value } = await readJsonFileWithFallback<MaxAccountState>(
    resolveMaxStatePath(accountId),
    {},
  );
  return value && typeof value === "object" ? value : {};
}

export async function saveMaxAccountState(accountId: string, state: MaxAccountState): Promise<void> {
  const filePath = resolveMaxStatePath(accountId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeJsonFileAtomically(filePath, state);
}

/**
 * In-memory handle over the persisted state with coalesced writes.
 * Mutations mark the state dirty; flushes are serialized and best-effort.
 */
export class MaxStateStore {
  private state: MaxAccountState = {};
  private dirty = false;
  private flushing: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(
    private accountId: string,
    private onError?: (err: unknown) => void,
  ) {}

  async load(): Promise<MaxAccountState> {
    if (!this.loaded) {
      this.state = await loadMaxAccountState(this.accountId);
      this.loaded = true;
    }
    return this.state;
  }

  get marker(): number | null | undefined {
    return this.state.marker;
  }

  setMarker(marker: number | null): void {
    if (this.state.marker === marker) return;
    this.state.marker = marker;
    this.scheduleFlush();
  }

  get chats(): Record<string, MaxChatRegistryEntry> {
    if (!this.state.chats) this.state.chats = {};
    return this.state.chats;
  }

  upsertChat(chatId: number, patch: Partial<MaxChatRegistryEntry>): void {
    const key = String(chatId);
    const existing = this.chats[key];
    const next: MaxChatRegistryEntry = { ...existing, ...patch, chatId };
    // A re-appearing chat is no longer removed/stopped unless the patch says so
    if (patch.removedAt === undefined && existing?.removedAt !== undefined && patch.addedAt !== undefined) {
      delete next.removedAt;
    }
    this.chats[key] = next;
    this.scheduleFlush();
  }

  hasChat(chatId: number): boolean {
    return String(chatId) in this.chats;
  }

  /** True only if the chat is known AND not marked removed. */
  hasActiveChat(chatId: number): boolean {
    const entry = this.chats[String(chatId)];
    return Boolean(entry) && entry.removedAt == null;
  }

  private scheduleFlush(): void {
    this.dirty = true;
    this.flushing = this.flushing.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      try {
        await saveMaxAccountState(this.accountId, this.state);
      } catch (err) {
        this.onError?.(err);
      }
    });
  }

  /** Wait for pending writes (used on shutdown/tests). */
  async flush(): Promise<void> {
    await this.flushing;
  }
}
