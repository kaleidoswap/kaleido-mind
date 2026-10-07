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

export type {
  InferenceMetrics,
  LLMProvider,
  ToolCallError,
  ToolChoice,
  TurnInput,
  TurnOutput,
} from './providers/types.js';

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
export { confirmReadback } from './wallet/confirm.js';
export {
  validateToolArgs,
  findUngroundedPaymentData,
  detectWalletAction,
  hasCapableTool,
  wantsToolCall,
  fixSatsBtcConversions,
  formatSatsAsBtc,
  DECLINED_TOOL_MESSAGE,
  declinedToolResult,
} from './guards.js';
export { annotateRgbBalances, fixRgbBalanceUnits, formatRgbAmount } from './context/rgb-units.js';
export type { ArgValidation, UngroundedItem, WalletAction } from './guards.js';

// ── Issue-an-RGB-asset recipe (opt-in — register via Funnel.recipes) ───────
export { issueAssetRecipe, extractIssueAsset } from './recipe/issue-asset.js';

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
  MemoryConsolidation,
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
export { compressToolResult, DEFAULT_PRESERVE_KEYS } from './context/compress.js';
export type { ToolCrushOptions, CrushResult } from './context/compress.js';
export { capabilityProfile } from './capabilities.js';
export type { CapabilityInput, MindCapabilities } from './capabilities.js';

// ── Domain packs ─────────────────────────────────────────────────────────────
// Each has its own subpath (`@kaleidorg/mind/kaleidoswap`, `/lsps1`,
// `/submarine`, `/bitrefill`, `/flashnet`, `/knowledge`). The root re-exports
// them for compatibility; 1.0 drops these re-exports.
export * from './kaleidoswap/index.js';
export * from './lsps1/index.js';
export * from './submarine/index.js';
export * from './bitrefill/index.js';
export * from './flashnet/index.js';
export * from './knowledge/index.js';

export { Engine } from './engine.js';
export type { EngineOptions, AgenticOptions, AgenticResult, ComposedSkill } from './engine.js';

// ── Funnel (T0 fast-path → T2 recipe → T1 agentic — the tiered agent) ───────
export { Funnel, DEFAULT_WALLET_SYSTEM } from './funnel.js';
export { skillAvailable, selectAvailableSkill } from './skills/select.js';
export type { FunnelOptions, FunnelSettings, FunnelCallbacks, FunnelResult } from './funnel.js';

export {
  SkillRegistry,
  parseSkill,
  keywordSelector,
  createEmbeddingSkillSelector,
  READ_REFERENCE_TOOL,
} from './skills/registry.js';
export { createSkillReferenceToolSource } from './skills/reference-source.js';
export { skillsFromBundle } from './skills/bundle.js';
export type { SkillBundle, BundledSkill } from './skills/bundle.js';
export type { Skill, SkillReference, SkillSelector } from './skills/types.js';

export { TurnLogger, defaultMask } from './logger.js';
export type { TurnLog, Device, LoggerIO, LoggerOptions } from './logger.js';

export {
  EVIDENCE_SCHEMA,
  EvidenceRecorder,
  sanitizeEvidenceEvent,
} from './evidence.js';
export type {
  EvidenceEvent,
  EvidenceEventType,
  EvidenceInput,
  EvidenceIO,
  EvidenceRecorderOptions,
  EvidenceSurface,
} from './evidence.js';

// ── Autonomy (the task brain: scheduled tasks + run history + spend guardrails)
// The operational half of the agent's memory — the state nanobot kept in
// tasks.json + cron + run history, lifted into core (storage/timers injected).
export {
  InMemoryTaskStore,
  defaultTaskSeeds,
  TaskRunLog,
  createTaskScheduler,
  evaluateSpend,
  DEFAULT_RISK_LIMITS,
  buildTaskPrompt,
  ZERO_ALLOCATION,
} from './autonomy/index.js';
export type {
  TaskAllocation,
  AgentTask,
  NewTask,
  TaskSeed,
  TaskStore,
  TaskStoreIO,
  TaskStoreOptions,
  TaskRunCost,
  TaskStats,
  TaskRunRecord,
  RunLogSnapshot,
  RunLogIO,
  RunLogOptions,
  TaskRunOutcome,
  RunTask,
  TimerHandle,
  SchedulerOptions,
  TaskScheduler,
  SpendKind,
  RiskLimits,
  SpendAction,
  RiskContext,
  RiskOutcome,
  RiskVerdict,
  TaskPromptOptions,
} from './autonomy/index.js';
