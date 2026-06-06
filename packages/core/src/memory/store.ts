/**
 * MemoryStore implementation — in-memory, with optional injected persistence
 * and optional semantic ranking. Pure TS, zero deps.
 *
 *   const store = new InMemoryMemoryStore();                // ephemeral
 *   const store = new InMemoryMemoryStore({ io });          // persisted (RN/Node)
 *   const store = new InMemoryMemoryStore({ io, embed });   // + semantic recall
 */

import { cosineSimilarity } from '../rag/vector-store.js';
import type {
  MemoryIO,
  MemoryItem,
  MemoryQuery,
  MemoryStore,
  NewMemory,
} from './types.js';

export interface MemoryStoreOptions {
  /** Persistence (load on first use, save on writes). Omit for ephemeral memory. */
  io?: MemoryIO;
  /** Embed text for semantic recall. Omit to fall back to substring matching. */
  embed?: (text: string) => Promise<number[]>;
  /** Clock — injectable for deterministic tests. */
  now?: () => number;
}

export class InMemoryMemoryStore implements MemoryStore {
  private items: MemoryItem[] = [];
  private hydrated = false;
  private counter = 0;
  private readonly io?: MemoryIO;
  private readonly embed?: (text: string) => Promise<number[]>;
  private readonly now: () => number;

  constructor(opts: MemoryStoreOptions = {}) {
    this.io = opts.io;
    this.embed = opts.embed;
    this.now = opts.now ?? (() => Date.now());
  }

  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    if (this.io) {
      try {
        this.items = await this.io.load();
        this.counter = this.items.length;
      } catch {
        this.items = [];
      }
    }
  }

  private async persist(): Promise<void> {
    if (this.io) await this.io.save(this.items);
  }

  async add(item: NewMemory): Promise<MemoryItem> {
    await this.hydrate();
    const embedding =
      item.embedding ?? (this.embed ? await this.embed(item.text).catch(() => undefined) : undefined);
    const full: MemoryItem = {
      id: item.id ?? `mem_${this.now()}_${++this.counter}`,
      text: item.text,
      kind: item.kind,
      tags: item.tags,
      createdAt: item.createdAt ?? this.now(),
      ...(embedding ? { embedding } : {}),
    };
    this.items.push(full);
    await this.persist();
    return full;
  }

  async all(): Promise<MemoryItem[]> {
    await this.hydrate();
    return [...this.items];
  }

  async search(query: MemoryQuery): Promise<MemoryItem[]> {
    await this.hydrate();
    const limit = query.limit ?? 5;

    let pool = this.items;
    if (query.kind) pool = pool.filter((m) => m.kind === query.kind);
    if (query.tags?.length) {
      pool = pool.filter((m) => query.tags!.every((t) => m.tags?.includes(t)));
    }

    const text = query.text?.trim();
    if (!text) {
      // No query text → most recent first.
      return [...pool].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    }

    // Semantic ranking when both the query and items are embedded.
    if (this.embed && pool.some((m) => m.embedding)) {
      const qv = await this.embed(text).catch(() => null);
      if (qv) {
        return [...pool]
          .map((m) => ({ m, score: m.embedding ? cosineSimilarity(qv, m.embedding) : -1 }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map((x) => x.m);
      }
    }

    // Fallback: substring score + recency.
    const q = text.toLowerCase();
    return [...pool]
      .map((m) => ({ m, hit: m.text.toLowerCase().includes(q) ? 1 : 0 }))
      .sort((a, b) => b.hit - a.hit || b.m.createdAt - a.m.createdAt)
      .slice(0, limit)
      .map((x) => x.m);
  }

  async remove(id: string): Promise<void> {
    await this.hydrate();
    this.items = this.items.filter((m) => m.id !== id);
    await this.persist();
  }

  async clear(): Promise<void> {
    await this.hydrate();
    this.items = [];
    await this.persist();
  }
}
