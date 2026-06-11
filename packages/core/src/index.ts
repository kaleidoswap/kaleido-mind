/**
 * @kaleido/mind — shared local-AI reasoning engine for KaleidoSwap.
 *
 * Pure TypeScript, zero runtime dependencies. Hosts inject:
 *   - an LLMProvider (wrapping @qvac/sdk, Anthropic, …)
 *   - one or more ToolSources (in-process wallet tools, MCP servers, …)
 *
 * and get the shared agentic loop, identical on mobile / desktop / agent.
 */

export type {
  Role,
  Message,
  ToolDef,
  ToolCall,
  ToolResult,
  ConfirmDecision,
} from './types.js';

export type { LLMProvider, TurnInput, TurnOutput } from './providers/types.js';

export type { ToolSource } from './tools/source.js';
export { InProcessToolSource } from './tools/in-process.js';
export type { InProcessTool } from './tools/in-process.js';
export { ToolRegistry } from './tools/registry.js';
export {
  createL402ToolSource,
  parseL402Challenge,
  bolt11AmountSats,
} from './tools/l402.js';
export type { L402Options, L402PayResult } from './tools/l402.js';
export { createCliToolSource, isAllowed } from './tools/cli.js';
export type { CliToolOptions, CommandRunner, CommandResult } from './tools/cli.js';

// ── Multi-L2 wallet tool contract (single source of truth) ─────────────────
export {
  WALLET_TOOLS,
  WALLET_LAYERS,
  SPEND_TOOLS,
  isSpendTool,
  getWalletTool,
  walletTools,
  toToolDefs,
  bindWalletTools,
} from './wallet/contract.js';
export type {
  WalletLayer,
  WalletToolDef,
  WalletHandler,
  BindWalletOptions,
} from './wallet/contract.js';

// ── KaleidoSwap maker tool contract (single source of truth) ────────────────
export {
  KALEIDOSWAP_TOOLS,
  KALEIDOSWAP_SPEND_TOOLS,
  isKaleidoswapSpendTool,
  getKaleidoswapTool,
  kaleidoswapTools,
  bindKaleidoswapTools,
} from './kaleidoswap/contract.js';
export type {
  KaleidoswapGroup,
  KaleidoswapToolDef,
  KaleidoswapHandler,
  BindKaleidoswapOptions,
} from './kaleidoswap/contract.js';

// ── Recipes (mobile multi-step: "recipes, not planning") ───────────────────
export { runRecipe, extractSlots, RecipeRegistry } from './recipe/runner.js';
export type { RunRecipeOptions } from './recipe/runner.js';
export { paymentsRecipe, extractPayment } from './recipe/payments.js';
export { swapRecipe, extractSwap } from './recipe/swap.js';
export { receiveRecipe, extractReceive } from './recipe/receive.js';
export { assetSendRecipe, extractAssetSend } from './recipe/asset-send.js';
export type { Recipe, RecipeStep, RecipeSlot, RecipeContext, RecipeResult, RecipeStatus } from './recipe/types.js';

// ── Tier-0 deterministic fast-path (no LLM) ────────────────────────────────
export { FastPath, WALLET_FAST_INTENTS } from './fastpath/fastpath.js';
export type { FastIntent, FastHit } from './fastpath/fastpath.js';

// ── Memory (soul + recall) ───────────────────────────────────────────────
export { InMemoryMemoryStore } from './memory/store.js';
export type { MemoryStoreOptions } from './memory/store.js';
export { createMemoryToolSource } from './memory/tool.js';
export type {
  AgentProfile,
  MemoryItem,
  MemoryKind,
  MemoryQuery,
  MemoryStore,
  MemoryIO,
  NewMemory,
} from './memory/types.js';

// ── RAG ──────────────────────────────────────────────────────────────────
export { Retriever, chunkText } from './rag/retriever.js';
export type { RetrieverOptions } from './rag/retriever.js';
export { InMemoryVectorStore, cosineSimilarity } from './rag/vector-store.js';
export { createRagToolSource } from './rag/tool.js';
export type { RagToolOptions } from './rag/tool.js';
export type {
  EmbeddingProvider,
  Chunk,
  RetrievedChunk,
  RagDocument,
  VectorStore,
  VectorStoreIO,
} from './rag/types.js';

// ── Context assembly + hardware budget ─────────────────────────────────────
export { ContextBuilder } from './context/builder.js';
export type { ContextBuilderOptions, BuildInput } from './context/builder.js';
export {
  estimateTokens,
  clampToTokens,
  contextBudgetTokens,
} from './context/budget.js';
export type { BudgetReserves } from './context/budget.js';
export { capabilityProfile } from './capabilities.js';
export type { CapabilityInput, MindCapabilities } from './capabilities.js';

// ── Knowledge packs + corpus adapters (for RAG) ────────────────────────────
export { BITCOIN_COPILOT_DOCS } from './knowledge/bitcoin-copilot.js';
export { walletHistoryToDocuments, contactsToDocuments } from './knowledge/wallet.js';
export type { WalletTx, Contact } from './knowledge/wallet.js';
export { merchantsToDocuments } from './knowledge/merchants.js';
export type { Merchant } from './knowledge/merchants.js';
export { createBtcMapToolSource, BTC_MAP_SAMPLE } from './knowledge/btc-map.js';
export type {
  BtcMapToolOptions,
  BtcMapMerchant,
  BtcMapFetch,
  LocationProvider,
  LatLng,
} from './knowledge/btc-map.js';

export { Engine } from './engine.js';
export type { EngineOptions, AgenticOptions, AgenticResult } from './engine.js';

// ── Funnel (T0 fast-path → T2 recipe → T1 agentic — the tiered agent) ───────
export { Funnel, DEFAULT_WALLET_SYSTEM } from './funnel.js';
export type { FunnelOptions, FunnelSettings, FunnelCallbacks, FunnelResult } from './funnel.js';

export {
  SkillRegistry,
  parseSkill,
  keywordSelector,
  READ_REFERENCE_TOOL,
} from './skills/registry.js';
export { createSkillReferenceToolSource } from './skills/reference-source.js';
export { skillsFromBundle } from './skills/bundle.js';
export type { SkillBundle, BundledSkill } from './skills/bundle.js';
export type { Skill, SkillReference, SkillSelector } from './skills/types.js';

export { TurnLogger, defaultMask } from './logger.js';
export type { TurnLog, Device, LoggerIO, LoggerOptions } from './logger.js';
