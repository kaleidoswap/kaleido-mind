/**
 * Capability profiling — decide which features to turn on for a given device +
 * model, so a 2 GB phone running a 0.6B model doesn't try to do everything.
 *
 * Pure heuristic. Hosts call this once (with device RAM + the model's context
 * size + whether an embedder is available) and get back feature flags + sane
 * retrieval defaults to feed the ContextBuilder.
 */

import { contextBudgetTokens } from './context/budget.js';

export interface CapabilityInput {
  /** Total device RAM in bytes (e.g. react-native-device-info getTotalMemory). */
  ramBytes?: number;
  /** The loaded model's context window in tokens (modelConfig.ctx_size). */
  modelCtxTokens: number;
  /** Whether an EmbeddingProvider is wired (QVAC embed, etc.). */
  hasEmbeddings?: boolean;
  /** Running inference on a remote provider (desktop/server) — relaxes limits. */
  delegated?: boolean;
}

export interface MindCapabilities {
  /** Long-term memory (cheap — on unless the window is tiny). */
  memory: boolean;
  /** Semantic recall for memory (needs embeddings). */
  semanticMemory: boolean;
  /** Embedding-only dedup of near-duplicate memories (zero inference — mobile-safe). */
  dedupeMemory: boolean;
  /** LLM merge of near-duplicate memories (an extra inference — capable/delegated only). */
  mergeMemory: boolean;
  /** Retrieval-augmented generation (needs embeddings + enough RAM/context). */
  rag: boolean;
  /** Token budget for injected system context. */
  contextBudgetTokens: number;
  /** Memories to auto-recall into context. */
  topKMemory: number;
  /** Knowledge chunks the search_knowledge tool returns. */
  topKRag: number;
}

const GiB = 1024 * 1024 * 1024;

export function capabilityProfile(input: CapabilityInput): MindCapabilities {
  const ramGb = input.delegated ? Infinity : (input.ramBytes ?? 0) / GiB;
  const ctx = input.modelCtxTokens;
  const hasEmb = !!input.hasEmbeddings;

  const budget = contextBudgetTokens(ctx);

  // Memory: on whenever there's room for a few lines. Semantic needs embeddings.
  const memory = budget >= 256;
  const semanticMemory = memory && hasEmb;

  // Consolidation: embedding-only dedup is cheap (no inference) — on wherever
  // semantic memory is. The LLM merge costs an extra inference, so reserve it
  // for delegated or roomy on-device setups; never run it on a tiny phone model.
  const dedupeMemory = semanticMemory;
  const mergeMemory = dedupeMemory && (input.delegated || (ramGb >= 4 && ctx >= 4096));

  // RAG is the expensive one: needs embeddings, a non-tiny context window, and
  // (on-device) enough RAM to hold an embedding model + index.
  const rag = hasEmb && ctx >= 4096 && (input.delegated || ramGb >= 3);

  // Scale how much we pull in with the available window.
  const topKMemory = budget >= 1500 ? 4 : budget >= 700 ? 3 : 2;
  const topKRag = rag ? (budget >= 2500 ? 5 : 3) : 0;

  return {
    memory,
    semanticMemory,
    dedupeMemory,
    mergeMemory,
    rag,
    contextBudgetTokens: budget,
    topKMemory,
    topKRag,
  };
}
