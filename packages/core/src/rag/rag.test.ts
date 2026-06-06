/** RAG tests — vector store, chunking, retriever + tool with a fake embedder. */

import { describe, it, expect } from 'vitest';
import { cosineSimilarity, InMemoryVectorStore } from './vector-store.js';
import { Retriever, chunkText } from './retriever.js';
import { createRagToolSource } from './tool.js';
import type { EmbeddingProvider } from './types.js';

// Deterministic bag-of-words embedder over a tiny vocab.
const VOCAB = ['btc', 'lightning', 'channel', 'swap', 'balance', 'rgb', 'price', 'esim'];
const fakeEmbeddings: EmbeddingProvider = {
  dimension: VOCAB.length,
  async embed(texts) {
    return texts.map((t) => {
      const lower = t.toLowerCase();
      return VOCAB.map((w) => (lower.match(new RegExp(w, 'g'))?.length ?? 0));
    });
  },
};

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal / degenerate', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('chunkText', () => {
  it('returns one chunk when short', () => {
    expect(chunkText('hello world', 800)).toEqual(['hello world']);
  });
  it('splits long text with overlap on boundaries', () => {
    const text = Array.from({ length: 50 }, (_, i) => `Sentence number ${i}.`).join(' ');
    const chunks = chunkText(text, 120, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 140)).toBe(true);
  });
});

describe('InMemoryVectorStore', () => {
  it('upserts (dedup by id) and queries by similarity', async () => {
    const store = new InMemoryVectorStore();
    await store.upsert([
      { id: 'a', text: 'about balance', embedding: [0, 0, 0, 0, 1, 0, 0, 0] },
      { id: 'b', text: 'about price', embedding: [0, 0, 0, 0, 0, 0, 1, 0] },
    ]);
    await store.upsert([{ id: 'a', text: 'about balance v2', embedding: [0, 0, 0, 0, 1, 0, 0, 0] }]);
    expect(await store.size()).toBe(2); // 'a' replaced, not duplicated

    const hits = await store.query([0, 0, 0, 0, 1, 0, 0, 0], 1);
    expect(hits[0].text).toBe('about balance v2');
    expect(hits[0].score).toBeCloseTo(1);
  });
});

describe('Retriever + RAG tool', () => {
  it('ingests, then retrieves the most relevant chunk', async () => {
    const retriever = new Retriever({ embeddings: fakeEmbeddings });
    const n = await retriever.ingest([
      { id: 'd1', text: 'How to open a lightning channel and manage balance.' },
      { id: 'd2', text: 'eSIM data plans and price comparison.' },
    ]);
    expect(n).toBeGreaterThanOrEqual(2);

    const hits = await retriever.search('what is my balance on lightning', 1);
    expect(hits[0].text).toMatch(/lightning channel/i);
  });

  it('search_knowledge tool returns formatted snippets', async () => {
    const retriever = new Retriever({ embeddings: fakeEmbeddings });
    await retriever.ingest([{ id: 'd', text: 'BTC swap and channel fees explained.' }]);
    const src = createRagToolSource(retriever, { k: 2 });
    expect(src.has('search_knowledge')).toBe(true);
    const out = await src.execute('search_knowledge', { query: 'swap channel' });
    expect(String(out)).toMatch(/swap and channel/i);
  });

  it('returns a friendly message when nothing matches', async () => {
    const retriever = new Retriever({ embeddings: fakeEmbeddings });
    const src = createRagToolSource(retriever);
    const out = await src.execute('search_knowledge', { query: 'anything' });
    expect(String(out)).toMatch(/No relevant passages/);
  });
});
