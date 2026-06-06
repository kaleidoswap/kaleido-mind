/**
 * Retriever — ties an injected EmbeddingProvider to a VectorStore: ingest
 * documents (chunk → embed → upsert) and search (embed query → top-k). Pure
 * TS; the embedding model is the host's (QVAC `embed()` on device).
 */

import { InMemoryVectorStore } from './vector-store.js';
import type {
  EmbeddingProvider,
  RagDocument,
  RetrievedChunk,
  VectorStore,
} from './types.js';

export interface RetrieverOptions {
  embeddings: EmbeddingProvider;
  /** Vector index (defaults to a fresh in-memory cosine store). */
  store?: VectorStore;
  /** Approx chars per chunk (default 800 ≈ 200 tokens). */
  chunkSize?: number;
  /** Chars of overlap between chunks (default 100). */
  chunkOverlap?: number;
}

/** Split text into overlapping chunks, preferring paragraph/sentence breaks. */
export function chunkText(text: string, size = 800, overlap = 100): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length <= size) return clean ? [clean] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      // Back up to the nearest paragraph/sentence/space boundary.
      const slice = clean.slice(start, end);
      const brk = Math.max(
        slice.lastIndexOf('\n\n'),
        slice.lastIndexOf('\n'),
        slice.lastIndexOf('. '),
        slice.lastIndexOf(' '),
      );
      if (brk > size * 0.5) end = start + brk + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

export class Retriever {
  private readonly embeddings: EmbeddingProvider;
  private readonly store: VectorStore;
  private readonly chunkSize: number;
  private readonly chunkOverlap: number;

  constructor(opts: RetrieverOptions) {
    this.embeddings = opts.embeddings;
    this.store = opts.store ?? new InMemoryVectorStore();
    this.chunkSize = opts.chunkSize ?? 800;
    this.chunkOverlap = opts.chunkOverlap ?? 100;
  }

  /** Chunk, embed, and index documents. Returns the number of chunks stored. */
  async ingest(docs: RagDocument[]): Promise<number> {
    const pending: { id: string; text: string; metadata?: Record<string, unknown> }[] = [];
    for (const doc of docs) {
      const pieces = chunkText(doc.text, this.chunkSize, this.chunkOverlap);
      pieces.forEach((text, i) => {
        const baseId = doc.id ?? `doc_${pending.length}`;
        pending.push({ id: `${baseId}#${i}`, text, metadata: doc.metadata });
      });
    }
    if (pending.length === 0) return 0;
    const vectors = await this.embeddings.embed(pending.map((p) => p.text));
    await this.store.upsert(
      pending.map((p, i) => ({ ...p, embedding: vectors[i] })),
    );
    return pending.length;
  }

  /** Embed the query and return the top-k most similar chunks. */
  async search(query: string, k = 4): Promise<RetrievedChunk[]> {
    if (!query.trim()) return [];
    const [qv] = await this.embeddings.embed([query]);
    if (!qv) return [];
    return this.store.query(qv, k);
  }

  vectorStore(): VectorStore {
    return this.store;
  }
}
