/**
 * Memory tool source — lets the agent persist and recall things across
 * sessions (`remember`, `recall`). Pairs with auto-recall in the
 * ContextBuilder; this is the explicit, agent-driven side.
 */

import type { ToolDef } from '../types.js';
import type { ToolSource } from '../tools/source.js';
import type { MemoryKind, MemoryStore } from './types.js';

const REMEMBER = 'remember';
const RECALL = 'recall';
const KINDS: MemoryKind[] = ['fact', 'preference', 'event', 'note'];

export function createMemoryToolSource(store: MemoryStore): ToolSource {
  const tools: ToolDef[] = [
    {
      name: REMEMBER,
      description:
        'Save something to long-term memory so you recall it in future sessions ' +
        '— a user preference, a fact, or an event. Use sparingly for durable info.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What to remember (a short sentence)' },
          kind: { type: 'string', enum: KINDS, description: 'fact | preference | event | note' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
        },
        required: ['text'],
      },
    },
    {
      name: RECALL,
      description:
        'Search your long-term memory for what you know about something before answering.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to recall' },
          limit: { type: 'number', description: 'Max items (default 5)' },
        },
        required: ['query'],
      },
    },
  ];

  async function execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === REMEMBER) {
      const text = String(args.text ?? '').trim();
      if (!text) throw new Error('remember: text is required');
      const kind = (KINDS as string[]).includes(String(args.kind))
        ? (args.kind as MemoryKind)
        : 'note';
      const tags = Array.isArray(args.tags) ? args.tags.map(String) : undefined;
      const item = await store.add({ text, kind, tags });
      return `Remembered (${item.kind}): ${item.text}`;
    }
    if (name === RECALL) {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('recall: query is required');
      const limit = Number(args.limit) > 0 ? Number(args.limit) : 5;
      const items = await store.search({ text: query, limit });
      if (items.length === 0) return 'Nothing relevant in memory.';
      return items.map((m) => `- (${m.kind}) ${m.text}`).join('\n');
    }
    throw new Error(`memory: unknown tool ${name}`);
  }

  const names = new Set([REMEMBER, RECALL]);
  return {
    id: 'memory',
    listTools: () => tools,
    has: (name) => names.has(name),
    execute,
  };
}
