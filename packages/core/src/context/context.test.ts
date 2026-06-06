/** Context budget + builder + capability tests. */

import { describe, it, expect } from 'vitest';
import { estimateTokens, clampToTokens, contextBudgetTokens } from './budget.js';
import { ContextBuilder } from './builder.js';
import { capabilityProfile } from '../capabilities.js';
import { InMemoryMemoryStore } from '../memory/store.js';
import type { AgentProfile } from '../memory/types.js';

const profile: AgentProfile = {
  name: 'KaleidoMind',
  soul: 'You are a sovereign, local-first Bitcoin assistant. Calm, precise, private.',
  instructions: 'Never reveal seeds. Confirm spends.',
};

describe('budget helpers', () => {
  it('estimates + clamps by ~4 chars/token', () => {
    expect(estimateTokens('a'.repeat(40))).toBe(10);
    const clamped = clampToTokens('word '.repeat(100), 10);
    expect(clamped.length).toBeLessThanOrEqual(10 * 4 + 1);
    expect(clamped.endsWith('…')).toBe(true);
  });

  it('reserves output/tools/conversation from the window', () => {
    expect(contextBudgetTokens(8192)).toBe(8192 - 512 - 600 - 768);
    expect(contextBudgetTokens(2048)).toBeGreaterThanOrEqual(256); // floor
    expect(contextBudgetTokens(512)).toBe(256); // clamped to floor
  });
});

describe('ContextBuilder', () => {
  it('always includes identity + instructions, then memory', async () => {
    const memory = new InMemoryMemoryStore({ now: () => 1 });
    await memory.add({ text: 'user prefers sats over USD', kind: 'preference' });
    const builder = new ContextBuilder({ profile, memory, topKMemory: 3, budgetTokens: 1024 });

    const { system } = await builder.build({ query: 'show my balance in sats' });
    expect(system).toMatch(/# KaleidoMind/);
    expect(system).toMatch(/Never reveal seeds/);
    expect(system).toMatch(/What you remember/);
    expect(system).toMatch(/prefers sats/);
  });

  it('keeps identity even under a tiny budget (drops optional sections)', async () => {
    const memory = new InMemoryMemoryStore({ now: () => 1 });
    await memory.add({ text: 'a'.repeat(400), kind: 'note' });
    const builder = new ContextBuilder({ profile, memory, topKMemory: 3, budgetTokens: 40 });
    const { system } = await builder.build({ query: 'x' });
    expect(system).toMatch(/# KaleidoMind/); // identity survives
  });

  it('splices in a composed skill playbook', async () => {
    const builder = new ContextBuilder({ profile, budgetTokens: 2048 });
    const { system } = await builder.build({
      query: 'buy a gift card',
      skillSystem: '## Active skill: bitrefill\nRoute the purchase.',
    });
    expect(system).toMatch(/Active skill: bitrefill/);
  });
});

describe('capabilityProfile', () => {
  it('low-end phone: memory yes, RAG no', () => {
    const c = capabilityProfile({ ramBytes: 2 * 1024 ** 3, modelCtxTokens: 2048, hasEmbeddings: true });
    expect(c.memory).toBe(true);
    expect(c.rag).toBe(false); // ctx too small + low RAM
    expect(c.topKRag).toBe(0);
  });

  it('desktop / delegated: RAG on', () => {
    const c = capabilityProfile({ modelCtxTokens: 8192, hasEmbeddings: true, delegated: true });
    expect(c.rag).toBe(true);
    expect(c.topKRag).toBeGreaterThan(0);
    expect(c.semanticMemory).toBe(true);
  });

  it('no embeddings → no RAG, no semantic memory', () => {
    const c = capabilityProfile({ ramBytes: 16 * 1024 ** 3, modelCtxTokens: 8192, hasEmbeddings: false });
    expect(c.rag).toBe(false);
    expect(c.semanticMemory).toBe(false);
    expect(c.memory).toBe(true);
  });
});
