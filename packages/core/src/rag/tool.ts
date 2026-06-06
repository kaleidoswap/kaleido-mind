/**
 * RAG tool source — exposes `search_knowledge` so the model can pull in
 * relevant context on demand (agentic RAG). Preferred over always-injecting
 * retrieved text, which burns the small-model context window.
 */

import type { ToolDef } from '../types.js';
import type { ToolSource } from '../tools/source.js';
import type { Retriever } from './retriever.js';

const SEARCH = 'search_knowledge';

export interface RagToolOptions {
  /** Chunks to return (default 4). */
  k?: number;
  /** Override the tool description for your corpus, e.g. "Search the docs." */
  description?: string;
}

export function createRagToolSource(retriever: Retriever, opts: RagToolOptions = {}): ToolSource {
  const tool: ToolDef = {
    name: SEARCH,
    description:
      opts.description ??
      'Search the knowledge base for passages relevant to a question and return ' +
        'the best matches. Use this before answering when the answer might be in ' +
        'ingested documents.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up' },
        k: { type: 'number', description: 'How many passages (default 4)' },
      },
      required: ['query'],
    },
  };

  async function execute(_name: string, args: Record<string, unknown>): Promise<unknown> {
    const query = String(args.query ?? '').trim();
    if (!query) throw new Error('search_knowledge: query is required');
    const k = Number(args.k) > 0 ? Number(args.k) : (opts.k ?? 4);
    const hits = await retriever.search(query, k);
    if (hits.length === 0) return 'No relevant passages found.';
    return hits
      .map((h, i) => `[${i + 1}] (score ${h.score.toFixed(2)}) ${h.text}`)
      .join('\n\n');
  }

  return {
    id: 'rag',
    listTools: () => [tool],
    has: (name) => name === SEARCH,
    execute,
  };
}
