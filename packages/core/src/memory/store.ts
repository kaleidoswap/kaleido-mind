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
  MemoryConsolidation,
  MemoryIO,
  MemoryItem,
  MemoryQuery,
  MemoryStore,
  NewMemory,
} from './types.js';

const DEFAULT_DEDUP_THRESHOLD = 0.92;

export interface MemoryStoreOptions {
  /** Persistence (load on first use, save on writes). Omit for ephemeral memory. */
  io?: MemoryIO;
  /** Embed text for semantic recall. Omit to fall back to substring matching. */
  embed?: (text: string) => Promise<number[]>;
  /**
   * Fold near-duplicate writes into one item instead of appending. Needs `embed`.
   * Omit for append-only. See {@link MemoryConsolidation}.
   */
  consolidate?: MemoryConsolidation;
  /** Clock — injectable for deterministic tests. */
  now?: () => number;
}

export class InMemoryMemoryStore implements MemoryStore {
  private items: MemoryItem[] = [];
  private hydrated = false;
  private counter = 0;
  private readonly io?: MemoryIO;
  private readonly embed?: (text: string) => Promise<number[]>;
  private readonly consolidate?: MemoryConsolidation;
  private readonly now: () => number;

  constructor(opts: MemoryStoreOptions = {}) {
    this.io = opts.io;
    this.embed = opts.embed;
    this.consolidate = opts.consolidate;
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
    let text = item.text;
    let embedding =
      item.embedding ?? (this.embed ? await this.embed(text).catch(() => undefined) : undefined);
    let tags = item.tags;
    let supersedeId: string | undefined;

    // Consolidation: fold a same-kind near-duplicate into this write instead of
    // appending — embedding-only by default, LLM rewrite when `merge` is set.
    if (this.consolidate && embedding) {
      const threshold = this.consolidate.threshold ?? DEFAULT_DEDUP_THRESHOLD;
      let best: { item: MemoryItem; score: number } | undefined;
      for (const m of this.items) {
        if (m.kind !== item.kind || !m.embedding) continue;
        const score = cosineSimilarity(embedding, m.embedding);
        if (!best || score > best.score) best = { item: m, score };
      }
      if (best && best.score >= threshold) {
        supersedeId = best.item.id;
        tags = unionTags(best.item.tags, item.tags);
        if (this.consolidate.merge) {
          const merged = await this.consolidate.merge(best.item.text, text).catch(() => null);
          if (merged && merged.trim()) {
            text = merged.trim();
            if (this.embed) embedding = await this.embed(text).catch(() => embedding);
          }
        }
        // No merger → the incoming (newer) text supersedes the older item as-is.
      }
    }

    const full: MemoryItem = {
      id: item.id ?? `mem_${this.now()}_${++this.counter}`,
      text,
      kind: item.kind,
      tags,
      createdAt: item.createdAt ?? this.now(),
      ...(embedding ? { embedding } : {}),
    };
    if (supersedeId) this.items = this.items.filter((m) => m.id !== supersedeId);
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

/** Merge two optional tag lists, de-duplicated. Returns undefined when both empty. */
function unionTags(a?: string[], b?: string[]): string[] | undefined {
  if (!a?.length && !b?.length) return undefined;
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}
