/**
 * In-memory vector store — pure-JS cosine similarity index. Zero deps, so it
 * bundles in Bare/RN. Good for thousands of chunks; swap in a native/SQLite
 * store via the VectorStore interface for larger corpora.
 */

import type { Chunk, RetrievedChunk, VectorStore, VectorStoreIO } from './types.js';

/** Cosine similarity of two equal-length vectors. Returns 0 on degenerate input. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface InMemoryVectorStoreOptions {
  io?: VectorStoreIO;
}

export class InMemoryVectorStore implements VectorStore {
  private chunks: Chunk[] = [];
  private hydrated = false;
  private readonly io?: VectorStoreIO;

  constructor(opts: InMemoryVectorStoreOptions = {}) {
    this.io = opts.io;
  }

  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    if (this.io) {
      try {
        this.chunks = await this.io.load();
      } catch {
        this.chunks = [];
      }
    }
  }

  async upsert(chunks: Chunk[]): Promise<void> {
    await this.hydrate();
    for (const c of chunks) {
      const i = this.chunks.findIndex((x) => x.id === c.id);
      if (i >= 0) this.chunks[i] = c;
      else this.chunks.push(c);
    }
    if (this.io) await this.io.save(this.chunks);
  }

  async query(embedding: number[], k: number): Promise<RetrievedChunk[]> {
    await this.hydrate();
    return this.chunks
      .filter((c) => c.embedding && c.embedding.length > 0)
      .map((c) => ({ ...c, score: cosineSimilarity(embedding, c.embedding!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  async size(): Promise<number> {
    await this.hydrate();
    return this.chunks.length;
  }

  async clear(): Promise<void> {
    await this.hydrate();
    this.chunks = [];
    if (this.io) await this.io.save(this.chunks);
  }
}
