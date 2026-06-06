/**
 * RAG types — retrieval-augmented generation primitives.
 *
 * The heavy parts (the embedding model, the vector index) are interfaces the
 * host injects. On QVAC the EmbeddingProvider wraps the SDK `embed()` API
 * (on-device); a server host could inject a remote embedder. The default
 * VectorStore is a pure-JS in-memory cosine index (good for thousands of
 * chunks); a host can swap in SQLite/native for more.
 */

/** Turns text into vectors. Injected — QVAC `embed()` on device, etc. */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  /** Vector dimension, when known (informational). */
  dimension?: number;
}

export interface Chunk {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
  embedding?: number[];
}

export interface RetrievedChunk extends Chunk {
  /** Similarity score in [-1, 1] (cosine). */
  score: number;
}

/** A document to ingest; chunked + embedded by the Retriever. */
export interface RagDocument {
  id?: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface VectorStore {
  upsert(chunks: Chunk[]): Promise<void>;
  /** Top-k by cosine similarity to `embedding`. */
  query(embedding: number[], k: number): Promise<RetrievedChunk[]>;
  size(): Promise<number>;
  clear(): Promise<void>;
}

/** Injected persistence for the vector store (optional). */
export interface VectorStoreIO {
  load(): Promise<Chunk[]>;
  save(chunks: Chunk[]): Promise<void>;
}
