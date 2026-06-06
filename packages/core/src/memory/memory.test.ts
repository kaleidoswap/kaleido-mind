/** Memory store + tool tests — deterministic, no embeddings needed. */

import { describe, it, expect, vi } from 'vitest';
import { InMemoryMemoryStore } from './store.js';
import { createMemoryToolSource } from './tool.js';
import type { MemoryItem, MemoryIO } from './types.js';

describe('InMemoryMemoryStore', () => {
  it('adds and recalls by recency when no query text', async () => {
    let t = 1000;
    const store = new InMemoryMemoryStore({ now: () => t++ });
    await store.add({ text: 'first', kind: 'note' });
    await store.add({ text: 'second', kind: 'note' });
    const all = await store.search({ limit: 5 });
    expect(all.map((m) => m.text)).toEqual(['second', 'first']); // newest first
  });

  it('filters by kind + tags, ranks substring hits first', async () => {
    let t = 0;
    const store = new InMemoryMemoryStore({ now: () => ++t });
    await store.add({ text: 'likes cold brew', kind: 'preference', tags: ['coffee'] });
    await store.add({ text: 'paid rent', kind: 'event' });
    await store.add({ text: 'prefers dark mode', kind: 'preference', tags: ['ui'] });

    const prefs = await store.search({ kind: 'preference', limit: 5 });
    expect(prefs).toHaveLength(2);

    const coffee = await store.search({ tags: ['coffee'], limit: 5 });
    expect(coffee.map((m) => m.text)).toEqual(['likes cold brew']);

    const hit = await store.search({ text: 'dark', limit: 5 });
    expect(hit[0].text).toBe('prefers dark mode');
  });

  it('persists through injected IO (load + save)', async () => {
    const saved: MemoryItem[] = [];
    const io: MemoryIO = {
      load: vi.fn(async () => [...saved]),
      save: vi.fn(async (items) => {
        saved.length = 0;
        saved.push(...items);
      }),
    };
    const store = new InMemoryMemoryStore({ io, now: () => 1 });
    await store.add({ text: 'remember me', kind: 'fact' });
    expect(io.save).toHaveBeenCalled();
    expect(saved).toHaveLength(1);

    // A fresh store hydrates from the same IO.
    const store2 = new InMemoryMemoryStore({ io, now: () => 2 });
    expect((await store2.all())[0].text).toBe('remember me');
  });

  it('semantic recall when an embedder is wired', async () => {
    // 2-dim embeddings: dimension 0 = "wallet"-ness, 1 = "weather"-ness.
    const embed = async (text: string): Promise<number[]> =>
      /balance|wallet|sats/i.test(text) ? [1, 0] : [0, 1];
    const store = new InMemoryMemoryStore({ embed, now: () => 1 });
    await store.add({ text: 'user wallet balance is low', kind: 'fact' });
    await store.add({ text: 'it is sunny today', kind: 'note' });
    const hits = await store.search({ text: 'how many sats do I have', limit: 1 });
    expect(hits[0].text).toMatch(/wallet balance/);
  });
});

describe('memory tool source', () => {
  it('remember saves and recall returns matches', async () => {
    const store = new InMemoryMemoryStore({ now: () => 1 });
    const src = createMemoryToolSource(store);
    expect(src.listTools().map((t) => t.name)).toEqual(['remember', 'recall']);

    const saved = await src.execute('remember', { text: 'BTC only', kind: 'preference' });
    expect(String(saved)).toMatch(/Remembered \(preference\)/);

    const recalled = await src.execute('recall', { query: 'BTC' });
    expect(String(recalled)).toMatch(/BTC only/);
  });

  it('defaults an invalid kind to note', async () => {
    const store = new InMemoryMemoryStore({ now: () => 1 });
    const src = createMemoryToolSource(store);
    await src.execute('remember', { text: 'x', kind: 'banana' });
    expect((await store.all())[0].kind).toBe('note');
  });
});
