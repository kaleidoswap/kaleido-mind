/**
 * Memory — the agent's persistent identity + what it has learned.
 *
 * Two layers, mirroring how nanobot splits SOUL.md / AGENTS.md / memory:
 *   - AgentProfile  — static identity ("who am I, how do I behave"). Injected.
 *   - MemoryStore   — durable, growing facts/preferences/events the agent
 *                     remembers across sessions. Pluggable storage.
 *
 * Pure data + interfaces — no storage or embedding deps. The host injects
 * persistence (AsyncStorage on RN, fs/SQLite on Node) and, optionally, an
 * EmbeddingProvider for semantic recall.
 */

/** Static agent identity, composed into the system prompt every turn. */
export interface AgentProfile {
  /** Display name, e.g. "KaleidoMind". */
  name: string;
  /** Persona / identity — the "soul". Who the agent is, its voice, its values. */
  soul: string;
  /** Operating instructions / house rules (optional). */
  instructions?: string;
}

export type MemoryKind = 'fact' | 'preference' | 'event' | 'note';

export interface MemoryItem {
  id: string;
  text: string;
  kind: MemoryKind;
  /** Epoch ms. */
  createdAt: number;
  tags?: string[];
  /** Optional embedding for semantic recall (set when an embedder is wired). */
  embedding?: number[];
}

/** What to add — id/createdAt/embedding are filled in by the store. */
export type NewMemory = Omit<MemoryItem, 'id' | 'createdAt' | 'embedding'> &
  Partial<Pick<MemoryItem, 'id' | 'createdAt' | 'embedding'>>;

export interface MemoryQuery {
  /** Free text to match (semantic if embeddings are available, else substring). */
  text?: string;
  kind?: MemoryKind;
  tags?: string[];
  /** Max items to return (default 5). */
  limit?: number;
}

export interface MemoryStore {
  add(item: NewMemory): Promise<MemoryItem>;
  all(): Promise<MemoryItem[]>;
  /** Best-matching items for the query (recency-ranked, or semantic if embedded). */
  search(query: MemoryQuery): Promise<MemoryItem[]>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

/** Injected persistence — load once, save on every mutation. RN/Node provide it. */
export interface MemoryIO {
  load(): Promise<MemoryItem[]>;
  save(items: MemoryItem[]): Promise<void>;
}

/**
 * Consolidation — fold near-duplicate memories of the same kind into one item
 * instead of letting memory bloat with "user likes EUR" ×5. Two tiers:
 *
 *   - **Dedup** (embedding-only, zero inference) — when a near-dup is found the
 *     newer item supersedes the older. Cheap enough for a 0.6B phone.
 *   - **Merge** (optional, injected LLM) — when `merge` is set, the old + new
 *     texts are rewritten into one consolidated fact. Reserve for capable /
 *     P2P-delegated devices; never run it on a tiny on-device model.
 *
 * Requires embeddings (the duplicate check is cosine similarity). Omit the whole
 * option for append-only behaviour.
 */
export interface MemoryConsolidation {
  /** Cosine threshold above which two same-kind memories are "the same". Default 0.92. */
  threshold?: number;
  /**
   * Optional LLM merger: given the existing and incoming text, return one
   * consolidated sentence. If omitted, the newer item simply supersedes the older.
   */
  merge?: (existing: string, incoming: string) => Promise<string>;
}
