/**
 * ContextBuilder — assembles the system prompt for a turn from, in priority
 * order: the agent's identity (soul) → operating instructions → the active
 * skill playbook → auto-recalled memories → auto-retrieved knowledge, trimmed
 * to a token budget so it never overflows a small model.
 *
 * Memory and RAG can ALSO be tools (the model pulls them in itself). Use this
 * for the always-on slice (identity + the most relevant memory/snippet); use
 * the tools (`recall`, `search_knowledge`) for deeper, on-demand lookups.
 */

import type { AgentProfile, MemoryStore } from '../memory/types.js';
import type { Retriever } from '../rag/retriever.js';
import { clampToTokens, estimateTokens } from './budget.js';

export interface ContextBuilderOptions {
  profile: AgentProfile;
  /** Auto-recall relevant memories into context. */
  memory?: MemoryStore;
  /** Auto-retrieve relevant knowledge into context. */
  retriever?: Retriever;
  /** Max tokens for the whole assembled system prompt (see contextBudgetTokens). */
  budgetTokens?: number;
  /** Memories to recall (default 3). */
  topKMemory?: number;
  /** Knowledge chunks to retrieve (default 0 — prefer the search_knowledge tool). */
  topKRag?: number;
}

export interface BuildInput {
  /** The user's message — drives memory recall + retrieval. */
  query: string;
  /** A composed skill playbook to splice in (from SkillRegistry.compose). */
  skillSystem?: string;
}

export class ContextBuilder {
  constructor(private readonly opts: ContextBuilderOptions) {}

  async build(input: BuildInput): Promise<{ system: string }> {
    const { profile } = this.opts;
    const budget = this.opts.budgetTokens ?? 1024;
    const sections: string[] = [];
    let used = 0;

    const add = (text: string, { force = false } = {}): void => {
      const t = text.trim();
      if (!t) return;
      const cost = estimateTokens(t) + 1;
      if (!force && used + cost > budget) {
        // Try to fit a trimmed version of optional sections.
        const room = budget - used - 1;
        if (room < 40) return;
        const trimmed = clampToTokens(t, room);
        sections.push(trimmed);
        used += estimateTokens(trimmed) + 1;
        return;
      }
      sections.push(t);
      used += cost;
    };

    // 1. Identity (always) — name + soul.
    add(`# ${profile.name}\n${profile.soul}`, { force: true });

    // 2. Operating instructions (always, if any).
    if (profile.instructions) add(`## Instructions\n${profile.instructions}`, { force: true });

    // 3. Active skill playbook.
    if (input.skillSystem) add(input.skillSystem);

    // 4. Auto-recalled memory.
    const kMem = this.opts.topKMemory ?? 3;
    if (this.opts.memory && kMem > 0) {
      try {
        const mems = await this.opts.memory.search({ text: input.query, limit: kMem });
        if (mems.length) {
          add(`## What you remember\n${mems.map((m) => `- (${m.kind}) ${m.text}`).join('\n')}`);
        }
      } catch {
        /* memory is best-effort */
      }
    }

    // 5. Auto-retrieved knowledge (opt-in; default prefers the tool).
    const kRag = this.opts.topKRag ?? 0;
    if (this.opts.retriever && kRag > 0) {
      try {
        const hits = await this.opts.retriever.search(input.query, kRag);
        if (hits.length) {
          add(`## Relevant context\n${hits.map((h) => h.text).join('\n\n')}`);
        }
      } catch {
        /* retrieval is best-effort */
      }
    }

    return { system: sections.join('\n\n') };
  }
}
