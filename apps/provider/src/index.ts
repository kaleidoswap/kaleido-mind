// apps/provider/src/index.ts
//
// Node sidecar entry point. Spawned by desktop-app/src-tauri/src/mind.rs.
//
// Lifecycle:
//   1. On launch, emit { type: 'ready' } and an initial { type: 'status' } (off).
//   2. Read JSON commands line-by-line from stdin.
//   3. Dispatch to the QVAC SDK (loadModel, startQVACProvider, completion, ...).
//   4. Emit JSON events on stdout. Diagnostics go to stderr.
//
// Wires to the real QVAC SDK via dynamic import — if @qvac/sdk isn't
// installed (e.g. CI), the sidecar runs in a clearly-labelled MOCK mode
// so the desktop-app build/test still works.

import * as readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentStateWire,
  type CatalogModel,
  type CapabilityInfo,
  type Command,
  type Event,
  type InstalledModel,
  type PeerInfo,
  type PortfolioTargetsWire,
  type ProviderStatusEvent,
  type SuggestedAction,
  decodeCommand,
  encodeEvent,
} from './protocol.js';
import {
  Funnel,
  ToolRegistry,
  SkillRegistry,
  createSkillReferenceToolSource,
  buyAssetChannelRecipe,
  kaleidoswapAtomicRecipe,
  kaleidoswapChannelOrderRecipe,
  assetSendRecipe,
  paymentsRecipe,
  receiveRecipe,
  // ── Autonomy (the agent's task brain) ──
  InMemoryTaskStore,
  TaskRunLog,
  createTaskScheduler,
  defaultTaskSeeds,
  buildTaskPrompt,
  evaluateSpend,
  DEFAULT_RISK_LIMITS,
  type AgentTask,
  type ConfirmDecision,
  type RiskContext,
  type RiskLimits,
  type Recipe,
  type Skill,
  type SpendAction,
  type SpendKind,
  type TaskRunOutcome,
  type TaskRunRecord,
  type LLMProvider,
  type Message,
  type ToolSource,
} from '@kaleidorg/mind';
import { loadSkillsDir, packagedSkillsDir } from '@kaleidorg/mind/skills';
import { createQvacProvider, firewallFromKeyList } from '@kaleidorg/mind/qvac';

// ─────────────────────────────────────────────────────────────────────
// IO helpers
// ─────────────────────────────────────────────────────────────────────

function emit(e: Event): void {
  process.stdout.write(encodeEvent(e));
}

function diag(message: string): void {
  process.stderr.write(`[mind-provider] ${message}\n`);
}

function respondOk(id: string, data?: unknown): void {
  emit({ type: 'response', id, ok: true, data });
}

function respondErr(id: string, error: string): void {
  emit({ type: 'response', id, ok: false, error });
}

// ─────────────────────────────────────────────────────────────────────
// QVAC SDK — dynamically imported so the sidecar starts even if absent
// ─────────────────────────────────────────────────────────────────────

interface QvacSDK {
  loadModel: (opts: any) => Promise<string>;
  unloadModel: (opts: { modelId: string; clearStorage?: boolean }) => Promise<void>;
  completion: (opts: any) => any;
  // Voice capabilities — served to paired phones over P2P once the matching
  // model is loaded (see loadVoiceModels). Optional so MOCK / older SDK builds
  // without the whisper/tts plugins still type-check.
  transcribe?: (opts: any) => Promise<any> | any;
  textToSpeech?: (opts: any) => any;
  startQVACProvider: (opts?: any) => Promise<any>;
  stopQVACProvider: () => Promise<void>;
  heartbeat?: (opts?: any) => Promise<unknown>;
  close: () => Promise<void>;
}

let sdk: QvacSDK | null = null;
// Raw module handle — kept so we can resolve pre-registered model descriptors
// (e.g. WHISPER_BASE_Q8_0, TTS_EN_SUPERTONIC_Q4_0) by export name at runtime.
let sdkModule: any = null;
let MOCK = false;

async function loadSdk(): Promise<void> {
  try {
    sdkModule = await import('@qvac/sdk');
    sdk = sdkModule as unknown as QvacSDK;
    diag('@qvac/sdk loaded');
  } catch (e) {
    MOCK = true;
    diag('@qvac/sdk not available — running in MOCK mode');
  }
}

// Forward the SDK server + model (llamacpp/whisper) logs into our `log` event
// stream so they show in the desktop "Recent activity" panel — the place to see
// WHY a model fell back to CPU, load timings, etc. We deliberately do NOT call
// setGlobalConsoleOutput(true): this sidecar uses stdout for the JSON protocol,
// so SDK console output would corrupt it. Subscribe once; the stream is the
// process-wide server log (available after the SDK server boots on first load).
let sdkLogsSubscribed = false;
function subscribeSdkLogs(): void {
  if (sdkLogsSubscribed || MOCK || !sdkModule?.loggingStream || !sdkModule?.SDK_LOG_ID) return;
  sdkLogsSubscribed = true;
  const verbose = process.env.KALEIDO_MIND_LOG_VERBOSE === '1';
  void (async () => {
    try {
      for await (const entry of sdkModule.loggingStream({ id: sdkModule.SDK_LOG_ID })) {
        if (!verbose && entry.level === 'debug') continue;
        const level = entry.level === 'off' ? 'info' : entry.level;
        emit({ type: 'log', level, message: `${entry.namespace}: ${entry.message}` });
      }
    } catch (e) {
      sdkLogsSubscribed = false;
      diag(`sdk log stream ended: ${(e as Error).message}`);
    }
  })();
}

// ─────────────────────────────────────────────────────────────────────
// Catalog — single source of truth (mirror of desktop-app's fallback)
// ─────────────────────────────────────────────────────────────────────

// All entries below have been probe-verified to return HTTP 302 (public CDN redirect).
const CATALOG: CatalogModel[] = [
  {
    id: 'qwen3-0.6b-q4_k_m',
    family: 'qwen3',
    displayName: 'Qwen 3 · 0.6B',
    quant: 'Q4_K_M',
    sizeBytes: 420_000_000,
    hfRepo: 'unsloth/Qwen3-0.6B-GGUF',
    hfFile: 'Qwen3-0.6B-Q4_K_M.gguf',
    ramHintGb: 1,
    notes: 'Tiny smoke-test model. Downloads in seconds. Use for end-to-end testing.',
  },
  {
    id: 'qwen3-1.7b-q4_k_m',
    family: 'qwen3',
    displayName: 'Qwen 3 · 1.7B',
    quant: 'Q4_K_M',
    sizeBytes: 1_100_000_000,
    hfRepo: 'unsloth/Qwen3-1.7B-GGUF',
    hfFile: 'Qwen3-1.7B-Q4_K_M.gguf',
    ramHintGb: 2,
    notes: 'Fastest usable agent. Good for mobile / quick desktop tests.',
  },
  {
    id: 'qwen3-4b-q4_k_m',
    family: 'qwen3',
    displayName: 'Qwen 3 · 4B',
    quant: 'Q4_K_M',
    sizeBytes: 2_400_000_000,
    hfRepo: 'unsloth/Qwen3-4B-GGUF',
    hfFile: 'Qwen3-4B-Q4_K_M.gguf',
    ramHintGb: 4,
    notes: 'Mobile sweet spot. Solid function calling.',
  },
  {
    id: 'qwen3-8b-q4_k_m',
    family: 'qwen3',
    displayName: 'Qwen 3 · 8B',
    quant: 'Q4_K_M',
    sizeBytes: 5_000_000_000,
    hfRepo: 'unsloth/Qwen3-8B-GGUF',
    hfFile: 'Qwen3-8B-Q4_K_M.gguf',
    ramHintGb: 7,
    notes: 'Daily-driver desktop choice. Function calling out of the box.',
  },
  {
    id: 'qwen3-14b-q4_k_m',
    family: 'qwen3',
    displayName: 'Qwen 3 · 14B',
    quant: 'Q4_K_M',
    sizeBytes: 9_000_000_000,
    hfRepo: 'unsloth/Qwen3-14B-GGUF',
    hfFile: 'Qwen3-14B-Q4_K_M.gguf',
    ramHintGb: 12,
    notes: 'Stronger reasoning. Solid on M4 24GB.',
  },
  {
    id: 'qwen3-30b-a3b-q4_k_m',
    family: 'qwen3',
    displayName: 'Qwen 3 · 30B-A3B (MoE)',
    quant: 'Q4_K_M',
    sizeBytes: 17_000_000_000,
    hfRepo: 'unsloth/Qwen3-30B-A3B-GGUF',
    hfFile: 'Qwen3-30B-A3B-Q4_K_M.gguf',
    ramHintGb: 20,
    notes: 'MoE — 30B params, 3B active. Best quality / speed on M4 24GB.',
  },
  {
    id: 'hermes-3-llama-3.1-8b-q4_k_m',
    family: 'hermes',
    displayName: 'Hermes 3 · Llama 3.1 8B',
    quant: 'Q4_K_M',
    sizeBytes: 5_000_000_000,
    hfRepo: 'NousResearch/Hermes-3-Llama-3.1-8B-GGUF',
    hfFile: 'Hermes-3-Llama-3.1-8B.Q4_K_M.gguf',
    ramHintGb: 7,
    notes: 'Agentic-tuned alternative. JSON-mode native.',
  },
];

const MODELS_DIR = join(homedir(), '.kaleido', 'models');
const CUSTOM_MODELS_FILE = join(MODELS_DIR, 'custom-models.json');
const SETTINGS_FILE = join(homedir(), '.kaleido', 'mind-settings.json');
const USER_SKILLS_DIR = join(homedir(), '.kaleido', 'skills');

interface SavedMcpServer {
  id: string;
  name: string;
  url: string;
}

interface ProviderSettings {
  disabledSkills: string[];
  deletedSkills: string[];
  mcpServers: SavedMcpServer[];
  /** Spend guardrails for autonomous task runs. */
  riskLimits?: RiskLimits;
  /** Target portfolio weights the rebalance loop steers toward. */
  portfolioTargets?: PortfolioTargetsWire;
  /** Generation token caps (0 ⇒ uncapped). */
  maxThinkingTokens?: number;
  maxOutputTokens?: number;
  /** Whether scheduled tasks should fire when a model is loaded. */
  schedulerRunning?: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────

const state = {
  providerOn: false,
  publicKey: null as string | null,
  activeModelId: null as string | null,
  activeModelName: null as string | null,
  qvacModelHandle: null as string | null,         // returned by loadModel()
  qvacSttHandle: null as string | null,            // Whisper model — delegated STT
  qvacTtsHandle: null as string | null,            // TTS model — delegated speech synthesis
  peers: new Map<string, PeerInfo>(),
  startedAt: null as number | null,
  tokensPerSecond: null as number | null,
  inferenceDevice: null as 'gpu' | 'cpu' | 'mock' | null,
  mcpSource: null as ToolSource | null,            // kaleido-mcp tools, when configured
  bitrefillSource: null as ToolSource | null,      // bitrefill remote MCP, when enabled
  skills: null as SkillRegistry | null,            // Agent Skills (loaded from skills/)
  refSource: null as ToolSource | null,            // read_skill_reference (progressive disclosure)
  chatHistory: [] as Message[],                    // rolling conversation (trimmed by the Funnel)
  chatThinking: '',                                // current turn's <think> reasoning (surfaced to the UI)
  disabledSkills: new Set<string>(),
  deletedSkills: new Set<string>(),
  activeChatId: null as string | null,
  customMcpSources: new Map<string, ToolSource>(),
  customMcpServers: new Map<string, SavedMcpServer>(),
  customMcpErrors: new Map<string, string>(),
};

async function loadProviderSettings(): Promise<void> {
  const fs = await import('node:fs/promises');
  try {
    const parsed = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')) as Partial<ProviderSettings>;
    state.disabledSkills = new Set(
      Array.isArray(parsed.disabledSkills) ? parsed.disabledSkills.filter((x): x is string => typeof x === 'string') : [],
    );
    state.deletedSkills = new Set(
      Array.isArray(parsed.deletedSkills) ? parsed.deletedSkills.filter((x): x is string => typeof x === 'string') : [],
    );
    for (const server of Array.isArray(parsed.mcpServers) ? parsed.mcpServers : []) {
      if (server?.id && server?.name && server?.url) state.customMcpServers.set(server.id, server);
    }
    if (parsed.riskLimits && typeof parsed.riskLimits === 'object') {
      riskLimits = { ...DEFAULT_RISK_LIMITS, ...parsed.riskLimits };
    }
    if (parsed.portfolioTargets && typeof parsed.portfolioTargets === 'object') {
      portfolioTargets = { ...DEFAULT_PORTFOLIO_TARGETS, ...parsed.portfolioTargets };
    }
    if (typeof parsed.maxThinkingTokens === 'number') {
      maxThinkingTokens = parsed.maxThinkingTokens > 0 ? parsed.maxThinkingTokens : undefined;
    }
    if (typeof parsed.maxOutputTokens === 'number') {
      maxOutputTokens = parsed.maxOutputTokens > 0 ? parsed.maxOutputTokens : undefined;
    }
    if (typeof parsed.schedulerRunning === 'boolean') {
      schedulerRunning = parsed.schedulerRunning;
    }
  } catch {
    // First run or malformed config: start with safe empty settings.
  }
}

async function saveProviderSettings(): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.mkdir(join(homedir(), '.kaleido'), { recursive: true });
  const settings: ProviderSettings = {
    disabledSkills: [...state.disabledSkills],
    deletedSkills: [...state.deletedSkills],
    mcpServers: [...state.customMcpServers.values()],
    riskLimits,
    portfolioTargets,
    maxThinkingTokens: maxThinkingTokens ?? 0,
    maxOutputTokens: maxOutputTokens ?? 0,
    schedulerRunning,
  };
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

function normalizeMcpUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('MCP URL must use http:// or https://.');
  }
  return url.toString();
}

async function connectCustomMcp(server: SavedMcpServer): Promise<void> {
  const old = state.customMcpSources.get(server.id);
  try {
    await (old as unknown as { close?: () => Promise<void> } | undefined)?.close?.();
  } catch {
    // Reconnection is best-effort.
  }
  state.customMcpSources.delete(server.id);
  state.customMcpErrors.delete(server.id);
  try {
    const { McpToolSource } = await import('@kaleidorg/mind/mcp');
    const source = new McpToolSource({
      id: `custom:${server.id}`,
      ...(process.env.KALEIDO_MIND_RLN_ONLY === '1'
        ? { denyPrefixes: ['wdk_', 'spark_'] }
        : {}),
      transport: { kind: 'http', url: server.url },
    });
    await source.connect();
    state.customMcpSources.set(server.id, source as unknown as ToolSource);
    emit({
      type: 'log',
      level: 'info',
      message: `MCP connected: ${server.name} (${source.listTools().length} tools)`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.customMcpErrors.set(server.id, message);
    emit({ type: 'log', level: 'warn', message: `MCP failed: ${server.name} — ${message}` });
  }
  emit({ type: 'capabilities_changed', capabilities: await capabilities() });
}

async function connectSavedMcps(): Promise<void> {
  await Promise.all([...state.customMcpServers.values()].map(connectCustomMcp));
}

async function addMcpServer(name: string, rawUrl: string): Promise<void> {
  const cleanName = name.trim();
  if (!cleanName) throw new Error('MCP server name is required.');
  const url = normalizeMcpUrl(rawUrl);
  const id = `${cleanName}-${url}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const server = { id, name: cleanName, url };
  state.customMcpServers.set(id, server);
  await saveProviderSettings();
  await connectCustomMcp(server);
}

async function removeMcpServer(id: string): Promise<void> {
  const source = state.customMcpSources.get(id);
  try {
    await (source as unknown as { close?: () => Promise<void> } | undefined)?.close?.();
  } catch {
    // Removing local config must still succeed.
  }
  state.customMcpSources.delete(id);
  state.customMcpServers.delete(id);
  state.customMcpErrors.delete(id);
  await saveProviderSettings();
}

// ─────────────────────────────────────────────────────────────────────
// Shared @kaleido/mind engine — the SAME agentic loop the mobile app runs.
// Provider wraps @qvac/sdk completion; tools come from kaleido-mcp (when
// KALEIDO_MCP_PATH is set), else the desktop chats tool-less.
// ─────────────────────────────────────────────────────────────────────

const RLN_ONLY = process.env.KALEIDO_MIND_RLN_ONLY === '1';

const DESKTOP_SYSTEM = [
  'You are KaleidoMind, a concise local AI for Bitcoin, Lightning and RGB.',
  RLN_ONLY ? 'This desktop uses RLN only. Never look for or mention WDK or Spark tools.' : '',
  'Call the available tool directly when it can answer or act. Never invent wallet data.',
  'Use exact user-provided values in tool arguments, including the full invoice.',
  'Do not repeat long invoices, addresses, hashes, tool schemas, or prior conversation in reasoning or prose.',
  'For a short follow-up such as "check now", use the recent result and call the relevant status/list tool.',
  'Think briefly: decide the next action, execute it, then report only the useful result.',
].filter(Boolean).join(' ');

// Opt-in recipes (atomic swap + buy-asset-channel onboarding) drive the
// kaleidoswap_*/rln_* MCP tools; the generic payments/receive/asset-send
// defaults stay registered too. ORDER MATTERS: atomic swap is FIRST so a plain
// "buy 1 usdt" on a funded node swaps over existing liquidity rather than
// opening a new channel. Shared by interactive chat and scheduled task runs.
/**
 * Adapt a core recipe's tool names to this host's MCP names. The LSPS1 contract
 * (and the channel-order recipe) use bare `lsp_*`; kaleido-mcp exposes them as
 * `kaleidoswap_lsp_*`, so we remap the tool of each step before registering.
 */
function remapRecipeTools(recipe: Recipe, map: Record<string, string>): Recipe {
  const r = (t: string) => map[t] ?? t;
  return {
    ...recipe,
    steps: recipe.steps.map((s) => ({ ...s, tool: r(s.tool) })),
    final: { ...recipe.final, tool: r(recipe.final.tool) },
  };
}

// "buy a 1M channel" / "500k inbound" → a DETERMINISTIC LSPS1 order (get_info →
// estimate_fees → node_info → ONE confirm → create_order → pay). Registering it
// stops a small model from driving this multi-step flow by hand — which failed
// by calling estimate_fees with undefined args and then looping until maxTurns.
const channelOrderRecipe = remapRecipeTools(kaleidoswapChannelOrderRecipe, {
  lsp_get_info: 'kaleidoswap_lsp_get_info',
  lsp_estimate_fees: 'kaleidoswap_lsp_estimate_fees',
  lsp_create_order: 'kaleidoswap_lsp_create_order',
});

const DESKTOP_RECIPES = [
  kaleidoswapAtomicRecipe,
  buyAssetChannelRecipe,
  // After buy-asset-channel (so "buy 100 USDT" stays an asset-channel buy),
  // before the generic send/receive recipes.
  channelOrderRecipe,
  assetSendRecipe,
  paymentsRecipe,
  receiveRecipe,
];

/** Live tool sources for a Funnel: kaleido-mcp + bitrefill + skill refs + custom. */
function funnelSources(): ToolSource[] {
  return [
    state.mcpSource,
    state.bitrefillSource,
    state.refSource,
    ...state.customMcpSources.values(),
  ].filter(Boolean) as ToolSource[];
}

/** Enabled skills, optionally narrowed to a specific set (for scoped task runs). */
function enabledSkills(only?: string[]): Skill[] {
  let skills = (state.skills?.list() ?? []).filter((s) => !state.disabledSkills.has(s.name));
  if (only && only.length) skills = skills.filter((s) => only.includes(s.name));
  if (RLN_ONLY) {
    skills = skills.map((skill) => ({
      ...skill,
      tools: skill.tools?.filter((name) => !name.startsWith('wdk_') && !name.startsWith('spark_')),
    }));
  }
  return skills;
}

// Bumped each time real SDK stats land (see onStats). handleChat reads it to
// tell whether a turn produced authoritative throughput or needs the fallback
// char-count estimate (recipe/fast tiers may not call the model at all).
let statsSeq = 0;

// Per chat-turn QVAC stats, summed across the agentic loop's model calls and
// returned with the reply so the chat can show real per-response tok/s, tokens
// and timing. Reset at the start of each handleChat.
interface TurnStats {
  promptTokens: number;
  totalTokens: number;
  genTimeMs: number;
  tps: number;
  device: 'gpu' | 'cpu' | null;
}
let turnStats: TurnStats = { promptTokens: 0, totalTokens: 0, genTimeMs: 0, tps: 0, device: null };
function resetTurnStats(): void {
  turnStats = { promptTokens: 0, totalTokens: 0, genTimeMs: 0, tps: 0, device: null };
}

// Cap the model's <think> reasoning by TOKENS (not seconds — tok/s varies by
// model + hardware, and the SDK exposes no numeric reasoning budget). ~128
// thinking tokens keeps simple wallet actions short on slower local models.
// Tune with KALEIDO_MIND_MAX_THINKING_TOKENS (0 ⇒ unlimited).
const MAX_THINKING_TOKENS: number | undefined = ((): number | undefined => {
  const env = process.env.KALEIDO_MIND_MAX_THINKING_TOKENS;
  if (env === undefined || env === '') return 128;
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : undefined; // 0 / invalid ⇒ unlimited
})();

// Total-output backstop (predict / n_predict). The thinking cap only bites when
// the model emits separate <think> tokens; a model that rambles in the VISIBLE
// answer needs a hard total-token ceiling so a turn still can't run away.
// 512 tokens is enough for wallet results without allowing a runaway answer.
// Tune with KALEIDO_MIND_MAX_TOKENS (0 ⇒ uncapped).
const MAX_OUTPUT_TOKENS: number | undefined = ((): number | undefined => {
  const env = process.env.KALEIDO_MIND_MAX_TOKENS;
  if (env === undefined || env === '') return 512;
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : undefined;
})();

// Live generation limits — seeded from the env defaults, then adjustable at
// runtime from the Agent tab (set_generation_limits). undefined ⇒ uncapped.
// The qvac provider reads these via getters, so a change takes effect next turn.
let maxThinkingTokens: number | undefined = MAX_THINKING_TOKENS;
let maxOutputTokens: number | undefined = MAX_OUTPUT_TOKENS;

// All QVAC completion logic lives in @kaleidorg/mind/qvac now (one place, shared
// with the mobile app). We inject the lazily-loaded SDK functions: `completion`
// is read at call time (the sidecar may start before @qvac/sdk finishes
// loading), and `getModelId` returns the currently-loaded model handle so the
// provider always runs against it. Cancellation isn't surfaced to the sidecar,
// but we forward it to the SDK when available.
const qvacProvider: LLMProvider = createQvacProvider({
  completion: ((params: unknown) => {
    if (!sdk) throw new Error('model not loaded');
    return sdk.completion(params);
  }) as Parameters<typeof createQvacProvider>[0]['completion'],
  cancel: (async (opts: { requestId: string }) => {
    try {
      await sdkModule?.cancel?.(opts);
    } catch {
      /* non-fatal */
    }
  }) as Parameters<typeof createQvacProvider>[0]['cancel'],
  getModelId: () => state.qvacModelHandle,
  // Read fresh each turn (getters) so the Agent tab can tune them live without a
  // restart. maxThinkingTokens caps <think>; defaultMaxTokens caps total output.
  get maxThinkingTokens() {
    return maxThinkingTokens;
  },
  get defaultMaxTokens() {
    return maxOutputTokens;
  },
  // Accumulate the model's <think> reasoning for the current chat turn so the
  // desktop UI can show it (collapsed by default). Reset per turn in handleChat.
  onThinking: (token: string) => {
    state.chatThinking += token;
    if (state.activeChatId) {
      emit({ type: 'chat_thinking_delta', chatId: state.activeChatId, delta: token });
    }
  },
  // The real per-turn inference stats (which backend ACTUALLY ran + throughput),
  // straight from the SDK's `final.stats` — replaces the optimistic load-time
  // device flag and the char-count tok/s estimate. Push a fresh status snapshot
  // so the desktop "is GPU active / tok/s" reads update live as you chat.
  onStats: (stats) => {
    statsSeq++;
    if (stats.backendDevice) state.inferenceDevice = stats.backendDevice;
    if (typeof stats.tokensPerSecond === 'number') {
      state.tokensPerSecond = Number(stats.tokensPerSecond.toFixed(1));
    }
    // Accumulate per-response stats for the active chat turn (an agentic run
    // calls the model several times; sum tokens/time, keep the latest tok/s).
    if (state.activeChatId) {
      if (typeof stats.totalTokens === 'number') turnStats.totalTokens += stats.totalTokens;
      if (typeof stats.promptTokens === 'number') turnStats.promptTokens += stats.promptTokens;
      if (typeof stats.totalTime === 'number') turnStats.genTimeMs += stats.totalTime;
      if (typeof stats.tokensPerSecond === 'number') turnStats.tps = stats.tokensPerSecond;
      if (stats.backendDevice) turnStats.device = stats.backendDevice;
    }
    emit(snapshot());
  },
});

/** Connect kaleido-mcp as a tool source if KALEIDO_MCP_PATH is configured. */
async function connectMcpIfConfigured(): Promise<void> {
  if (MOCK || state.mcpSource) return;
  const mcpEntry = process.env.KALEIDO_MCP_PATH; // path to kaleido-mcp dist/index.js
  if (!mcpEntry) {
    diag('KALEIDO_MCP_PATH not set — desktop chat runs tool-less');
    return;
  }
  try {
    const { McpToolSource } = await import('@kaleidorg/mind/mcp');
    const src = new McpToolSource({
      id: 'kaleido',
      ...(RLN_ONLY ? { denyPrefixes: ['wdk_', 'spark_'] } : {}),
      transport: {
        kind: 'stdio',
        command: 'node',
        args: [mcpEntry],
        env: { ...process.env, WDK_SEED: process.env.WDK_SEED ?? '' } as Record<string, string>,
      },
    });
    await src.connect();
    state.mcpSource = src as unknown as ToolSource;
    const n = src.listTools().length;
    diag(`kaleido-mcp connected: ${n} tools`);
    emit({ type: 'log', level: 'info', message: `kaleido-mcp connected: ${n} tools` });
  } catch (e) {
    diag(`kaleido-mcp connect failed: ${(e as Error).message}`);
    emit({ type: 'log', level: 'warn', message: `kaleido-mcp connect failed: ${(e as Error).message}` });
  }
}

/**
 * Load Agent Skills from the vendored `skills/` folder (SKILL.md + references).
 * Best-effort: if the folder is missing the brain just runs skill-less.
 * Override the location with KALEIDO_SKILLS_DIR.
 */
function loadSkills(): void {
  const packagedDir = process.env.KALEIDO_SKILLS_DIR ?? packagedSkillsDir();
  try {
    const packaged = loadSkillsDir(packagedDir);
    const custom = loadSkillsDir(USER_SKILLS_DIR);
    const byName = new Map(packaged.map((skill) => [skill.name, skill]));
    for (const skill of custom) byName.set(skill.name, skill);
    const skills = [...byName.values()].filter((skill) => !state.deletedSkills.has(skill.name));
    if (!skills.length) {
      state.skills = new SkillRegistry();
      state.refSource = createSkillReferenceToolSource(state.skills) as unknown as ToolSource;
      diag(`no skills found in ${packagedDir} or ${USER_SKILLS_DIR}`);
      return;
    }
    state.skills = new SkillRegistry(skills);
    state.refSource = createSkillReferenceToolSource(state.skills) as unknown as ToolSource;
    diag(`loaded ${skills.length} skill(s): ${skills.map((s) => s.name).join(', ')}`);
    emit({ type: 'log', level: 'info', message: `skills loaded: ${skills.map((s) => s.name).join(', ')}` });
  } catch (e) {
    diag(`skill load failed: ${(e as Error).message}`);
  }
}

function skillSlug(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new Error('Skill name must contain letters or numbers.');
  return slug;
}

async function addSkill(
  name: string,
  description: string,
  instructions: string,
  tools: string[] = [],
): Promise<void> {
  const slug = skillSlug(name);
  if (!description.trim()) throw new Error('Skill description is required.');
  if (!instructions.trim()) throw new Error('Skill instructions are required.');
  const fs = await import('node:fs/promises');
  const dir = join(USER_SKILLS_DIR, slug);
  await fs.mkdir(dir, { recursive: true });
  const safeDescription = description.trim().replace(/\r?\n/g, ' ');
  const cleanTools = tools.map((tool) => tool.trim()).filter(Boolean);
  const markdown = [
    '---',
    `name: ${slug}`,
    `description: "${safeDescription.replace(/"/g, '\\"')}"`,
    ...(cleanTools.length ? [`tools: ${cleanTools.join(', ')}`] : []),
    '---',
    '',
    `# ${name.trim()}`,
    '',
    instructions.trim(),
    '',
  ].join('\n');
  await fs.writeFile(join(dir, 'SKILL.md'), markdown, 'utf8');
  state.deletedSkills.delete(slug);
  state.disabledSkills.delete(slug);
  await saveProviderSettings();
  loadSkills();
}

async function deleteSkill(name: string): Promise<void> {
  const fs = await import('node:fs/promises');
  const slug = skillSlug(name);
  try {
    await fs.rm(join(USER_SKILLS_DIR, slug), { recursive: true, force: true });
  } catch {
    // Built-in skills are hidden through settings; user skills are also removed.
  }
  state.deletedSkills.add(name);
  state.deletedSkills.add(slug);
  state.disabledSkills.delete(name);
  state.disabledSkills.delete(slug);
  await saveProviderSettings();
  loadSkills();
}

/**
 * Connect the Bitrefill remote MCP (gift cards / top-ups / eSIMs) as a tool
 * source. Enabled by default; set BITREFILL_MCP=0 to disable. An optional
 * BITREFILL_API_KEY is sent as a bearer token (purchases need auth; browse may
 * not). Best-effort — failure just means no Bitrefill tools.
 */
async function connectBitrefillMcpIfEnabled(): Promise<void> {
  if (MOCK || state.bitrefillSource) return;
  if (process.env.BITREFILL_MCP === '0') {
    diag('BITREFILL_MCP=0 — bitrefill tools disabled');
    return;
  }
  // The remote MCP rejects anonymous connections (401) — it needs an API key
  // (or interactive OAuth, which a headless sidecar can't do). Skip the connect
  // unless a key is present, so the bitrefill skill simply routes to its other
  // channels (CLI / API / link) instead of logging a guaranteed failure.
  const key = process.env.BITREFILL_API_KEY;
  if (!key && process.env.BITREFILL_MCP !== '1') {
    diag('BITREFILL_API_KEY not set — bitrefill MCP skipped (skill routes via other channels)');
    return;
  }
  try {
    const { McpToolSource } = await import('@kaleidorg/mind/mcp');
    const src = new McpToolSource({
      id: 'bitrefill',
      transport: {
        kind: 'http',
        url: process.env.BITREFILL_MCP_URL ?? 'https://api.bitrefill.com/mcp',
        headers: key ? { Authorization: `Bearer ${key}` } : undefined,
      },
    });
    await src.connect();
    state.bitrefillSource = src as unknown as ToolSource;
    const n = src.listTools().length;
    diag(`bitrefill MCP connected: ${n} tools`);
    emit({ type: 'log', level: 'info', message: `bitrefill MCP connected: ${n} tools` });
  } catch (e) {
    diag(`bitrefill MCP connect failed: ${(e as Error).message}`);
    emit({ type: 'log', level: 'warn', message: `bitrefill MCP connect failed: ${(e as Error).message}` });
  }
}

function snapshot(): ProviderStatusEvent {
  return {
    type: 'status',
    on: state.providerOn,
    publicKey: state.publicKey,
    activeModelId: state.activeModelId,
    activeModelName: state.activeModelName,
    peers: Array.from(state.peers.values()),
    tokensPerSecond: state.tokensPerSecond,
    startedAt: state.startedAt,
    inferenceDevice: state.inferenceDevice,
    sttReady: state.qvacSttHandle != null,
    ttsReady: state.qvacTtsHandle != null,
  };
}

async function customCatalog(): Promise<CatalogModel[]> {
  const fs = await import('node:fs/promises');
  try {
    const parsed = JSON.parse(await fs.readFile(CUSTOM_MODELS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function allCatalog(): Promise<CatalogModel[]> {
  return [...CATALOG, ...(await customCatalog())];
}

function parseHuggingFaceUrl(rawUrl: string): { repo: string; file?: string } {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error('Paste a Hugging Face repository URL.');
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'huggingface.co') {
    throw new Error('Use an https://huggingface.co/owner/model URL.');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('The URL must include a Hugging Face owner and repository.');
  const repo = `${parts[0]}/${parts[1]}`;
  const viewIndex = parts.findIndex((part) => part === 'blob' || part === 'resolve');
  const file = viewIndex >= 0 ? parts.slice(viewIndex + 2).join('/') : undefined;
  if (file?.includes('/')) throw new Error('Only top-level GGUF files are supported.');
  return { repo, file };
}

function ggufPreference(file: string): number {
  const priorities = [
    /Q4_K_M\.gguf$/i,
    /Q4_K_S\.gguf$/i,
    /IQ4_NL\.gguf$/i,
    /Q5_K_M\.gguf$/i,
    /Q4_0\.gguf$/i,
    /Q5_K_S\.gguf$/i,
    /Q6_K\.gguf$/i,
    /Q8_0\.gguf$/i,
    /Q3_K_M\.gguf$/i,
    /Q2_K\.gguf$/i,
    /F16\.gguf$/i,
  ];
  const rank = priorities.findIndex((pattern) => pattern.test(file));
  return rank === -1 ? priorities.length : rank;
}

async function resolveHuggingFaceModel(rawUrl: string): Promise<{ repo: string; file: string; sizeBytes: number }> {
  const parsed = parseHuggingFaceUrl(rawUrl);
  let file = parsed.file;
  if (file && !file.toLowerCase().endsWith('.gguf')) {
    throw new Error('The pasted Hugging Face file URL is not a .gguf model.');
  }
  if (!file) {
    const apiUrl = `https://huggingface.co/api/models/${parsed.repo}?expand%5B%5D=siblings`;
    const response = await fetch(apiUrl);
    if (!response.ok) {
      throw new Error(`Could not read that Hugging Face repository (${response.status}).`);
    }
    const data = await response.json() as { siblings?: Array<{ rfilename?: string }> };
    const candidates = (data.siblings ?? [])
      .map((entry) => entry.rfilename ?? '')
      .filter((name) =>
        name.toLowerCase().endsWith('.gguf') &&
        !name.includes('/') &&
        !/mmproj/i.test(name) &&
        !/-\d{5}-of-\d{5}\.gguf$/i.test(name)
      )
      .sort((a, b) => ggufPreference(a) - ggufPreference(b) || a.localeCompare(b));
    file = candidates[0];
    if (!file) throw new Error('No downloadable top-level GGUF model was found in that repository.');
  }

  let sizeBytes = 0;
  try {
    const head = await fetch(`https://huggingface.co/${parsed.repo}/resolve/main/${file}`, {
      method: 'HEAD',
      redirect: 'follow',
    });
    sizeBytes = Number(head.headers.get('content-length') ?? '0');
  } catch {
    // The actual download still discovers the size from its response.
  }
  return { repo: parsed.repo, file, sizeBytes };
}

async function addCustomModel(url: string, displayName?: string): Promise<CatalogModel> {
  const { repo: cleanRepo, file: cleanFile, sizeBytes } = await resolveHuggingFaceModel(url);
  if (!/^[\w.-]+\/[\w.-]+$/.test(cleanRepo)) throw new Error('Use a Hugging Face repo like owner/model.');
  const id = `hf-${cleanRepo}-${cleanFile}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const model: CatalogModel = {
    id,
    family: cleanRepo.split('/')[1] ?? 'custom',
    displayName: displayName?.trim() || cleanFile.replace(/\.gguf$/i, ''),
    quant: cleanFile.match(/(q\d(?:_[a-z0-9]+)+)/i)?.[1]?.toUpperCase() ?? 'GGUF',
    sizeBytes,
    hfRepo: cleanRepo,
    hfFile: cleanFile,
    ramHintGb: 0,
    notes: `Custom model from Hugging Face: ${cleanRepo}`,
  };
  const fs = await import('node:fs/promises');
  await fs.mkdir(MODELS_DIR, { recursive: true });
  const current = await customCatalog();
  await fs.writeFile(
    CUSTOM_MODELS_FILE,
    JSON.stringify([...current.filter((m) => m.id !== id), model], null, 2),
    'utf8',
  );
  return model;
}

// ─────────────────────────────────────────────────────────────────────
// Installed models — fs scan of ~/.kaleido/models
// ─────────────────────────────────────────────────────────────────────

async function listInstalledModels(): Promise<InstalledModel[]> {
  const fs = await import('node:fs/promises');
  let entries: string[] = [];
  try {
    entries = await fs.readdir(MODELS_DIR);
  } catch {
    return [];
  }
  const catalog = await allCatalog();
  const installed: InstalledModel[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.gguf')) continue;
    const match = catalog.find((c) => c.hfFile === entry);
    if (!match) continue;
    const path = join(MODELS_DIR, entry);
    try {
      const stat = await fs.stat(path);
      installed.push({
        id: match.id,
        family: match.family,
        displayName: match.displayName,
        sizeBytes: stat.size,
        path,
        active: state.activeModelId === match.id,
      });
    } catch {
      // skip
    }
  }
  return installed;
}

// ─────────────────────────────────────────────────────────────────────
// Command handlers
// ─────────────────────────────────────────────────────────────────────

/** Race a promise against a timeout. Resolves with `null` on timeout. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

// ─────────────────────────────────────────────────────────────────────
// Voice (STT/TTS) delegation
//
// Loaded alongside the LLM so the QVAC provider advertises transcription and
// speech-synthesis to paired phones over the same Hyperswarm channel as
// completion. Best-effort: if the SDK build lacks the whisper/tts plugins (or
// the model constant), the provider still serves LLM-only and just logs it.
// Disable with KALEIDO_MIND_VOICE=0; override the models with the
// KALEIDO_MIND_STT_MODEL / KALEIDO_MIND_TTS_MODEL env vars (names of @qvac/sdk
// model-descriptor exports, e.g. WHISPER_LARGE_V3_TURBO).
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_STT_MODEL = 'WHISPER_BASE_Q8_0';
const DEFAULT_TTS_MODEL = 'TTS_EN_SUPERTONIC_Q4_0';

/** Resolve a pre-registered @qvac/sdk model descriptor by export name. */
function resolveModelConst(name: string): any {
  return sdkModule?.[name] ?? null;
}

/**
 * Load the Whisper (STT) and Supertonic (TTS) models so delegated transcribe()
 * / textToSpeech() calls from paired phones are served by this provider. Each
 * is independent and best-effort — a failure on one leaves the other (and the
 * LLM) working.
 */
async function loadVoiceModels(): Promise<void> {
  if (MOCK || !sdk) return;
  if (process.env.KALEIDO_MIND_VOICE === '0') {
    diag('voice delegation disabled (KALEIDO_MIND_VOICE=0)');
    return;
  }

  // STT — Whisper transcription.
  const sttName = process.env.KALEIDO_MIND_STT_MODEL || DEFAULT_STT_MODEL;
  const sttSrc = resolveModelConst(sttName);
  if (!sttSrc) {
    diag(`STT model constant not found: ${sttName} — transcription delegation off`);
  } else {
    try {
      state.qvacSttHandle = await sdk.loadModel({
        modelSrc: sttSrc,
        modelType: 'whispercpp-transcription',
        modelConfig: { language: 'en', strategy: 'greedy', audio_format: 's16le' },
      });
      diag(`STT model loaded for delegation: ${sttName}`);
      emit({ type: 'log', level: 'info', message: `voice: transcription ready (${sttName})` });
    } catch (e) {
      diag(`STT load failed (${sttName}): ${(e as Error).message}`);
      emit({ type: 'log', level: 'warn', message: `voice: transcription unavailable — ${(e as Error).message}` });
    }
  }

  // TTS — neural speech synthesis.
  const ttsName = process.env.KALEIDO_MIND_TTS_MODEL || DEFAULT_TTS_MODEL;
  const ttsSrc = resolveModelConst(ttsName);
  if (!ttsSrc) {
    diag(`TTS model constant not found: ${ttsName} — speech-synthesis delegation off`);
  } else {
    try {
      state.qvacTtsHandle = await sdk.loadModel({
        modelSrc: ttsSrc,
        modelType: 'tts-ggml',
        modelConfig: { ttsEngine: 'supertonic', language: 'en', voice: 'F1', ttsSpeed: 1.05, ttsNumInferenceSteps: 5 },
      });
      diag(`TTS model loaded for delegation: ${ttsName}`);
      emit({ type: 'log', level: 'info', message: `voice: speech synthesis ready (${ttsName})` });
    } catch (e) {
      diag(`TTS load failed (${ttsName}): ${(e as Error).message}`);
      emit({ type: 'log', level: 'warn', message: `voice: speech synthesis unavailable — ${(e as Error).message}` });
    }
  }
}

async function handleStart(modelId: string): Promise<void> {
  if (state.providerOn) {
    throw new Error('Provider is already running. Stop it first.');
  }
  state.chatHistory = []; // fresh conversation per provider session
  const installed = await listInstalledModels();
  const model = installed.find((m) => m.id === modelId);
  if (!model) {
    throw new Error(`Model not installed: ${modelId}. Download it first.`);
  }

  emit({ type: 'provider_loading', phase: 'loading_model', percentage: 0, message: `Loading ${model.displayName}…` });

  if (MOCK || !sdk) {
    // Mock provider — short fake load so the UI gets to see the phase
    await new Promise((r) => setTimeout(r, 300));
    emit({ type: 'provider_loading', phase: 'model_loaded' });
    state.qvacModelHandle = `mock-${modelId}`;
    state.inferenceDevice = 'mock';
    emit({ type: 'provider_loading', phase: 'starting_p2p' });
    await new Promise((r) => setTimeout(r, 200));
    state.publicKey = mockPubkey();
  } else {
    // ── Real path ──────────────────────────────────────────────────
    try {
      state.qvacModelHandle = await sdk.loadModel({
        modelSrc: model.path,
        modelType: 'llm',
        // tools: true enables the llamacpp tool-calling grammar — required for
        // the agent to emit structured tool calls instead of talking about them.
        modelConfig: { ctx_size: 16384, tools: true, device: 'gpu', gpu_layers: 99 },
        onProgress: (p: { percentage: number }) => {
          diag(`load progress: ${p.percentage}%`);
          emit({ type: 'provider_loading', phase: 'loading_model', percentage: p.percentage });
        },
      });
      state.inferenceDevice = 'gpu';
    } catch (e) {
      diag(`GPU load failed, retrying on CPU: ${(e as Error).message}`);
      emit({ type: 'log', level: 'warn', message: `Metal/GPU unavailable; retrying on CPU — ${(e as Error).message}` });
      try {
        state.qvacModelHandle = await sdk.loadModel({
          modelSrc: model.path,
          modelType: 'llm',
          modelConfig: { ctx_size: 8192, tools: true, device: 'cpu', gpu_layers: 0 },
        });
        state.inferenceDevice = 'cpu';
      } catch (cpuError) {
        emit({ type: 'provider_loading', phase: 'aborted', message: `Failed to load model: ${(cpuError as Error).message}` });
        throw new Error(`load failed: ${(cpuError as Error).message}`);
      }
    }

    // The SDK server is up now — start forwarding its logs (load timings, the
    // real backend, any Metal fallback reason) into the desktop activity panel.
    subscribeSdkLogs();

    emit({ type: 'provider_loading', phase: 'model_loaded' });

    // Load the voice models (best-effort) before advertising, so the provider
    // comes up already able to serve delegated STT/TTS to paired phones.
    await loadVoiceModels();

    emit({ type: 'provider_loading', phase: 'starting_p2p', message: 'Connecting to Hyperswarm…' });

    // Firewall: a QVAC provider is reachable by anyone who learns its public key,
    // so by default any such peer can run inference here. Set KALEIDO_MIND_ALLOWED_KEYS
    // (comma/space/newline-separated consumer public keys, e.g. the paired phone's)
    // to allow-list ONLY those peers. Unset ⇒ open, with a loud warning.
    const firewall = firewallFromKeyList(process.env.KALEIDO_MIND_ALLOWED_KEYS);
    if (firewall) {
      diag(`P2P firewall: allow-list of ${firewall.publicKeys.length} consumer key(s)`);
    } else {
      const msg = 'P2P firewall OPEN — KALEIDO_MIND_ALLOWED_KEYS unset; any peer with this public key can delegate inference here.';
      diag(msg);
      emit({ type: 'log', level: 'warn', message: msg });
    }

    // 60 s ceiling on the P2P bootstrap — DHT can take ~30s on first run.
    let provider: any = null;
    try {
      provider = await withTimeout(sdk.startQVACProvider(firewall ? { firewall } : {}), 60_000);
    } catch (e) {
      diag(`startQVACProvider threw: ${(e as Error).message}`);
    }

    // Diagnostic: log the full response so we can see the real field names.
    diag(`startQVACProvider returned: ${JSON.stringify(provider)}`);

    if (!provider) {
      const msg = 'P2P bootstrap timed out after 60s — desktop-only mode.';
      diag(msg);
      emit({ type: 'provider_loading', phase: 'p2p_failed', message: msg });
      emit({ type: 'log', level: 'warn', message: msg });
      state.publicKey = null;
    } else if (provider.success === false) {
      const msg = `startQVACProvider failed: ${provider.error ?? 'unknown'}`;
      diag(msg);
      emit({ type: 'provider_loading', phase: 'p2p_failed', message: msg });
      emit({ type: 'log', level: 'warn', message: msg });
      state.publicKey = null;
    } else {
      // Try every plausible field name we've seen across SDK versions.
      state.publicKey =
        (provider?.publicKey as string) ??
        (provider?.public_key as string) ??
        (provider?.pubkey as string) ??
        (provider?.keyPair?.publicKey as string) ??
        (provider?.keyPair?.publicKey?.toString?.('hex') as string) ??
        null;
      if (!state.publicKey) {
        const msg = `startQVACProvider returned success but no publicKey field. Keys: ${Object.keys(provider).join(', ')}`;
        diag(msg);
        emit({ type: 'provider_loading', phase: 'p2p_failed', message: msg });
        emit({ type: 'log', level: 'warn', message: msg });
      }
    }
  }

  state.providerOn = true;
  state.activeModelId = model.id;
  state.activeModelName = model.displayName;
  state.startedAt = Date.now();
  state.tokensPerSecond = MOCK ? 24 : null;

  // Best-effort: load skills + attach tool sources so desktop chat is a full,
  // skill-routed agent (kaleido-mcp wallet/trading + bitrefill commerce).
  loadSkills();
  await connectMcpIfConfigured();
  await connectBitrefillMcpIfEnabled();
  // User-added MCP servers are optional capabilities. Reconnect them in the
  // background so an offline/slow server can never block the model becoming
  // usable or leave the Models screen stuck on "Loading".
  void connectSavedMcps();

  if (state.publicKey) emit({ type: 'pubkey', value: state.publicKey });
  emit({ type: 'provider_loading', phase: 'ready' });
  emit(snapshot());
  // A model is now loaded — arm the task scheduler if the user left it on.
  startScheduler();
}

async function handleStop(): Promise<void> {
  if (!state.providerOn) return;
  // Tasks call the model; stop firing them when the model unloads.
  stopScheduler();
  if (sdk && !MOCK) {
    try {
      await sdk.stopQVACProvider();
    } catch (e) {
      diag(`stopQVACProvider error: ${(e as Error).message}`);
    }
    if (state.qvacModelHandle) {
      try {
        await sdk.unloadModel({ modelId: state.qvacModelHandle });
      } catch (e) {
        diag(`unloadModel error: ${(e as Error).message}`);
      }
    }
    for (const voiceHandle of [state.qvacSttHandle, state.qvacTtsHandle]) {
      if (!voiceHandle) continue;
      try {
        await sdk.unloadModel({ modelId: voiceHandle });
      } catch (e) {
        diag(`unloadModel (voice) error: ${(e as Error).message}`);
      }
    }
  }
  for (const key of ['mcpSource', 'bitrefillSource'] as const) {
    const src = state[key];
    if (src) {
      try {
        await (src as unknown as { close?: () => Promise<void> }).close?.();
      } catch {
        /* ignore */
      }
      state[key] = null;
    }
  }
  for (const source of state.customMcpSources.values()) {
    try {
      await (source as unknown as { close?: () => Promise<void> }).close?.();
    } catch {
      /* ignore */
    }
  }
  state.customMcpSources.clear();
  state.providerOn = false;
  state.publicKey = null;
  state.activeModelId = null;
  state.activeModelName = null;
  state.qvacModelHandle = null;
  state.qvacSttHandle = null;
  state.qvacTtsHandle = null;
  state.peers.clear();
  state.startedAt = null;
  state.tokensPerSecond = null;
  state.inferenceDevice = null;
  emit(snapshot());
}

async function handleSetActiveModel(modelId: string): Promise<void> {
  const wasOn = state.providerOn;
  if (wasOn) await handleStop();
  state.activeModelId = modelId;
  if (wasOn) await handleStart(modelId);
}

/** In-flight downloads — for guard + cancel. */
const downloadAborts = new Map<string, AbortController>();

async function handleDownload(modelId: string): Promise<void> {
  // Single-download policy: at most one model is downloaded at a time, across
  // the whole sidecar. A request that arrives while another is in flight is
  // dropped with a log event so the UI can show a toast.
  if (downloadAborts.size > 0) {
    const other = Array.from(downloadAborts.keys())[0];
    const msg = other === modelId
      ? `download already in flight: ${modelId}`
      : `another download is in progress (${other}); finish or cancel it first`;
    diag(msg);
    emit({ type: 'log', level: 'warn', message: msg });
    return;
  }

  const model = (await allCatalog()).find((c) => c.id === modelId);
  if (!model) throw new Error(`Unknown model: ${modelId}`);

  const fs = await import('node:fs');
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const { Readable, Transform } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');

  await fsp.mkdir(MODELS_DIR, { recursive: true });
  const finalPath = path.join(MODELS_DIR, model.hfFile);
  const tmpPath = `${finalPath}.partial`;

  // Skip if already on disk and looks complete.
  try {
    const stat = await fsp.stat(finalPath);
    if ((model.sizeBytes === 0 && stat.size > 1_000_000) || stat.size >= model.sizeBytes * 0.99) {
      diag(`already installed: ${finalPath}`);
      emit({
        type: 'download_progress',
        progress: { modelId, bytesDownloaded: stat.size, bytesTotal: stat.size, percentage: 100 },
      });
      emit({ type: 'download_completed', modelId });
      return;
    }
  } catch {
    // not present — proceed
  }

  const abort = new AbortController();
  downloadAborts.set(modelId, abort);

  const url = `https://huggingface.co/${model.hfRepo}/resolve/main/${model.hfFile}`;
  diag(`download starting: ${url}`);

  let res: Response;
  try {
    res = await fetch(url, { redirect: 'follow', signal: abort.signal });
  } catch (e) {
    downloadAborts.delete(modelId);
    diag(`fetch threw: ${(e as Error).message}`);
    emit({ type: 'log', level: 'error', message: `network error: ${(e as Error).message}` });
    return;
  }
  if (!res.ok || !res.body) {
    downloadAborts.delete(modelId);
    const msg = `HF returned ${res.status} ${res.statusText} for ${url}`;
    diag(msg);
    emit({ type: 'log', level: 'error', message: msg });
    return;
  }

  const contentLength = Number(res.headers.get('content-length') ?? '0');
  const totalBytes = contentLength || model.sizeBytes;
  diag(`fetch OK, content-length=${contentLength}, total=${totalBytes}`);

  let downloaded = 0;
  let lastEmitPct = -1;
  let lastEmitAt = 0;

  // Emit one progress event right away so the UI hides the "Download" button
  // and shows the bar before any bytes arrive.
  emit({
    type: 'download_progress',
    progress: { modelId, bytesDownloaded: 0, bytesTotal: totalBytes, percentage: 0 },
  });

  // Convert web ReadableStream → Node Readable (built-in helper, robust)
  const body = Readable.fromWeb(res.body as any);

  // Transform pass-through that observes byte counts and emits progress
  const progress = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      downloaded += chunk.length;
      const pct = totalBytes ? Math.floor((downloaded / totalBytes) * 100) : 0;
      const now = Date.now();
      // Throttle: emit on percent change OR every 250 ms.
      if (pct !== lastEmitPct || now - lastEmitAt > 250) {
        lastEmitPct = pct;
        lastEmitAt = now;
        emit({
          type: 'download_progress',
          progress: { modelId, bytesDownloaded: downloaded, bytesTotal: totalBytes, percentage: pct },
        });
      }
      cb(null, chunk);
    },
  });

  const writeStream = fs.createWriteStream(tmpPath);

  try {
    await pipeline(body, progress, writeStream);
  } catch (e) {
    downloadAborts.delete(modelId);
    try { await fsp.unlink(tmpPath); } catch {}
    if (abort.signal.aborted) {
      diag(`download cancelled: ${modelId}`);
      return;
    }
    const msg = `download failed: ${(e as Error).message}`;
    diag(msg);
    emit({ type: 'log', level: 'error', message: msg });
    return;
  }

  // Atomic move into place so partial files are never visible to the loader.
  await fsp.rename(tmpPath, finalPath);
  downloadAborts.delete(modelId);

  emit({
    type: 'download_progress',
    progress: { modelId, bytesDownloaded: downloaded, bytesTotal: totalBytes, percentage: 100 },
  });
  emit({ type: 'download_completed', modelId });
  diag(`download complete: ${finalPath} (${downloaded} bytes)`);
}

function handleCancelDownload(modelId: string): void {
  const abort = downloadAborts.get(modelId);
  if (abort) {
    abort.abort();
    downloadAborts.delete(modelId);
  }
}

async function handleDeleteModel(modelId: string): Promise<void> {
  const installed = await listInstalledModels();
  const model = installed.find((m) => m.id === modelId);
  if (!model) return;
  const fsp = await import('node:fs/promises');
  try {
    await fsp.unlink(model.path);
    diag(`deleted: ${model.path}`);
  } catch (e) {
    throw new Error(`delete failed: ${(e as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Autonomy — the agent's task brain (scheduled tasks + run history + risk).
//
// Tasks fire on their interval through the SAME Funnel the chat uses, scoped to
// the task's skill. A spend inside an autonomous run passes through
// evaluateSpend: blocked (dry-run / over a limit), auto-approved (under the
// threshold), or surfaced to the desktop as a proactive confirmation card.
// Stores are fs-backed under ~/.kaleido (host IO for the in-memory core stores).
// ─────────────────────────────────────────────────────────────────────

const KALEIDO_DIR = join(homedir(), '.kaleido');
const TASKS_FILE = join(KALEIDO_DIR, 'mind-tasks.json');
const RUNLOG_FILE = join(KALEIDO_DIR, 'mind-runlog.json');

let riskLimits: RiskLimits = { ...DEFAULT_RISK_LIMITS };
const DEFAULT_PORTFOLIO_TARGETS: PortfolioTargetsWire = {
  btcPct: 70,
  usdtPct: 20,
  xautPct: 10,
  driftThresholdPct: 5,
};
let portfolioTargets: PortfolioTargetsWire = { ...DEFAULT_PORTFOLIO_TARGETS };
let schedulerRunning = false; // persisted intent; only fires once a model is loaded

const taskStore = new InMemoryTaskStore({
  io: {
    load: async () => {
      try {
        const fs = await import('node:fs/promises');
        return JSON.parse(await fs.readFile(TASKS_FILE, 'utf8')) as AgentTask[];
      } catch {
        return [];
      }
    },
    save: async (tasks) => {
      const fs = await import('node:fs/promises');
      await fs.mkdir(KALEIDO_DIR, { recursive: true });
      await fs.writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
    },
  },
});

const runLog = new TaskRunLog({
  io: {
    load: async () => {
      try {
        const fs = await import('node:fs/promises');
        return JSON.parse(await fs.readFile(RUNLOG_FILE, 'utf8'));
      } catch {
        return null;
      }
    },
    save: async (snapshot) => {
      const fs = await import('node:fs/promises');
      await fs.mkdir(KALEIDO_DIR, { recursive: true });
      await fs.writeFile(RUNLOG_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
    },
  },
});

/** Best-effort spend shape from a tool call — feeds the risk gate. */
function inferSpendAction(call: { name: string; arguments: Record<string, unknown> }): SpendAction {
  const a = call.arguments ?? {};
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = a[k];
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  };
  const kind: SpendKind = /channel/i.test(call.name)
    ? 'channel'
    : /swap|atomic|order/i.test(call.name)
      ? 'swap'
      : /send/i.test(call.name)
        ? 'send'
        : 'pay';
  return {
    kind,
    amountSat: num('total_sat', 'amount_sat', 'btc_amount_sat'),
    amountUsd: num('amount_usd', 'usd', 'value_usd'),
  };
}

/**
 * Snapshot spendable BTC (sats) via kaleido-mcp's rln_get_balances — vanilla
 * on-chain spendable + Lightning local balance (colored UTXOs back RGB assets,
 * so they're excluded). Returns undefined if the tool isn't available or the
 * result can't be parsed; the risk gate then falls back to its dry-run + size
 * checks without the reserve/stop-loss floors.
 */
async function fetchBtcBalanceSat(): Promise<number | undefined> {
  const registry = new ToolRegistry(funnelSources());
  if (!(await registry.getDef('rln_get_balances'))) return undefined;
  try {
    const raw = await registry.execute('rln_get_balances', {});
    const obj = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
      btc_onchain?: { vanilla_spendable_sats?: unknown };
      lightning_balance_sat?: unknown;
    };
    const vanilla = Number(obj?.btc_onchain?.vanilla_spendable_sats ?? 0);
    const lightning = Number(obj?.lightning_balance_sat ?? 0);
    const total = (Number.isFinite(vanilla) ? vanilla : 0) + (Number.isFinite(lightning) ? lightning : 0);
    return Number.isFinite(total) ? total : undefined;
  } catch (e) {
    diag(`risk-gate balance fetch failed: ${(e as Error).message}`);
    return undefined;
  }
}

/** Confirmation gate for an autonomous run: enforce risk, else surface a card. */
async function autonomousConfirm(
  call: { name: string; arguments: Record<string, unknown> },
  ctx: RiskContext = {},
): Promise<ConfirmDecision> {
  const verdict = evaluateSpend(inferSpendAction(call), riskLimits, ctx);
  diag(`autonomous spend ${call.name}: ${verdict.outcome} — ${verdict.reason}`);
  if (verdict.outcome === 'block') return { approved: false, reason: verdict.reason };
  if (verdict.outcome === 'allow') return { approved: true };
  // Needs a human: surface a proactive confirmation card to the desktop.
  return requestToolConfirmation(call);
}

/** Run one scheduled task through the skill-scoped Funnel. */
async function runScheduledTask(task: AgentTask): Promise<TaskRunOutcome> {
  if (MOCK || !sdk || !state.qvacModelHandle) {
    return { ok: false, error: 'model not loaded' };
  }
  emit({ type: 'task_run_started', taskId: task.id, taskName: task.name, at: Date.now() });
  // Snapshot the live BTC balance once so the risk gate can enforce the reserve
  // and stop-loss floors this run (evaluateSpend needs btcBalanceSat).
  const riskCtx: RiskContext = { btcBalanceSat: await fetchBtcBalanceSat() };
  const funnel = new Funnel({
    provider: qvacProvider,
    tools: new ToolRegistry(funnelSources()),
    skills: enabledSkills([task.skill]),
    system: DESKTOP_SYSTEM,
    maxTurns: 8,
    log: (m) => diag(m),
    recipes: DESKTOP_RECIPES,
  });
  // Background run: no activeChatId, so onToken/tool events don't stream into a
  // user chat. Spends route through the risk gate (which may surface a card).
  state.activeChatId = null;
  let toolCalls = 0;
  const res = await funnel.runTurn(
    buildTaskPrompt(task, {
      dryRun: riskLimits.dryRun,
      // Surface the portfolio targets + live balance + risk floors so the
      // rebalance/heartbeat skills have something concrete to reason against.
      params: {
        targets: portfolioTargets,
        btc_balance_sat: riskCtx.btcBalanceSat,
        risk: {
          maxSpendUsd: riskLimits.maxSpendUsd,
          minBtcReserveSat: riskLimits.minBtcReserveSat,
          stopLossBtcSat: riskLimits.stopLossBtcSat,
        },
      },
    }),
    {
      onToolCall: () => {
        toolCalls += 1;
      },
      onConfirm: (call) => autonomousConfirm(call, riskCtx),
    },
  );
  return { ok: true, text: res.text, toolCalls };
}

const scheduler = createTaskScheduler({
  store: taskStore,
  run: runScheduledTask,
  now: () => Date.now(),
  tickMs: 30_000,
  concurrency: 1,
  log: (m) => diag(`scheduler: ${m}`),
  onOutcome: (task, outcome, durationMs) => void recordTaskRun(task, outcome, durationMs),
});

/**
 * Turn a finished task run into a proactive chat message — or null to stay quiet.
 * Skills return strict JSON ({action, reason, …}); routine "all good" results
 * (ok/noop/skip) are suppressed so a 5-min heartbeat doesn't spam the chat. A
 * failure or a non-routine action (rebalance/alert/buy) is always surfaced.
 */
function formatTaskMessage(task: AgentTask, outcome: TaskRunOutcome): string | null {
  if (!outcome.ok) {
    return `⚠️ **${task.name}** failed: ${outcome.error ?? 'unknown error'}`;
  }
  const raw = (outcome.text ?? '').trim();
  let action: string | undefined;
  let reason: string | undefined;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const obj = JSON.parse(m[0]) as { action?: unknown; reason?: unknown };
      if (typeof obj.action === 'string') action = obj.action.toLowerCase();
      if (typeof obj.reason === 'string') reason = obj.reason;
    }
  } catch {
    /* not JSON — fall back to the raw text */
  }
  const ROUTINE = ['ok', 'noop', 'none', 'healthy', 'skip', 'no-op'];
  if (action && ROUTINE.includes(action)) return null;
  const body = (reason || raw).trim();
  if (!body) return null;
  const icon = action === 'alert' ? '⚠️' : '🔔';
  return `${icon} **${task.name}** — ${body.slice(0, 400)}`;
}

async function recordTaskRun(
  task: AgentTask,
  outcome: TaskRunOutcome,
  durationMs: number,
): Promise<void> {
  const record: TaskRunRecord = {
    taskId: task.id,
    taskName: task.name,
    startedAt: Date.now() - durationMs,
    durationMs,
    toolCalls: outcome.toolCalls ?? 0,
    ok: outcome.ok,
    error: outcome.error ?? null,
    text: outcome.text ?? '',
    cost: {
      usd: outcome.cost?.usd ?? 0,
      inputTokens: outcome.cost?.inputTokens ?? 0,
      outputTokens: outcome.cost?.outputTokens ?? 0,
    },
  };
  await runLog.record(record);
  emit({ type: 'task_run_finished', record });
  // Proactively message the user about this run (suppressed for routine results).
  const message = formatTaskMessage(task, outcome);
  if (message) {
    emit({
      type: 'agent_message',
      text: message,
      taskId: task.id,
      taskName: task.name,
      at: Date.now(),
    });
  }
  emit({ type: 'agent_state', state: await agentStateInfo() });
  await emitTasksChanged();
}

async function agentStateInfo(): Promise<AgentStateWire> {
  const snap = await runLog.snapshot();
  return {
    schedulerRunning: scheduler.isRunning(),
    risk: riskLimits,
    targets: portfolioTargets,
    generation: {
      maxThinkingTokens: maxThinkingTokens ?? 0,
      maxOutputTokens: maxOutputTokens ?? 0,
    },
    recent: snap.recent,
    stats: snap.stats,
    cumulative: snap.cumulative,
  };
}

async function emitTasksChanged(): Promise<void> {
  emit({ type: 'tasks_changed', tasks: await taskStore.list() });
}

/** Start the scheduler if intended AND a model is loaded (tasks call the model). */
function startScheduler(): void {
  if (schedulerRunning && !scheduler.isRunning() && !MOCK && state.qvacModelHandle) {
    scheduler.start();
  }
}

function stopScheduler(): void {
  if (scheduler.isRunning()) scheduler.stop();
}

/** Four one-tap starters the chat shows as cards on the first screen. */
function suggestedActions(): SuggestedAction[] {
  return [
    {
      id: 'balance',
      icon: 'wallet',
      title: 'Check my balances',
      subtitle: 'BTC, USDT & XAUT across your node',
      prompt: "What's my balance?",
    },
    {
      id: 'node',
      icon: 'node',
      title: 'Node & channel health',
      subtitle: 'Channels, liquidity and pending transfers',
      prompt: 'How are my channels and node doing?',
    },
    {
      id: 'portfolio',
      icon: 'portfolio',
      title: 'Optimize my portfolio',
      subtitle: 'Check drift vs targets and suggest a rebalance',
      prompt: 'Review my portfolio allocation and suggest a rebalance',
    },
    {
      id: 'buy',
      icon: 'trade',
      title: 'Buy 100 USDT',
      subtitle: 'Quote and open an asset channel',
      prompt: 'Buy 100 USDT',
    },
  ];
}

/**
 * Contextual follow-ups proposed AFTER a chat turn — rendered as tappable
 * buttons so the next step is always one tap away. Heuristic (keyed off the
 * user's request), so it costs no extra inference.
 */
function followupActions(prompt: string): SuggestedAction[] {
  const p = prompt.toLowerCase();
  const a = (id: string, icon: string, title: string, next: string): SuggestedAction => ({
    id,
    icon,
    title,
    subtitle: '',
    prompt: next,
  });
  if (/balance|funds|how much|holding/.test(p)) {
    return [
      a('fu-buy', 'trade', 'Buy 100 USDT', 'Buy 100 USDT'),
      a('fu-chan', 'node', 'Check channels', 'How are my channels and node doing?'),
      a('fu-opt', 'portfolio', 'Optimize portfolio', 'Review my portfolio allocation and suggest a rebalance'),
    ];
  }
  if (/channel|node|liquidity|inbound|outbound/.test(p)) {
    return [
      a('fu-bal', 'wallet', 'Check balances', "What's my balance?"),
      a('fu-buychan', 'node', 'Buy inbound capacity', 'Buy a 100 USDT channel'),
      a('fu-opt', 'portfolio', 'Optimize portfolio', 'Review my portfolio allocation and suggest a rebalance'),
    ];
  }
  if (/portfolio|rebalanc|allocation|optimi|drift/.test(p)) {
    return [
      a('fu-bal', 'wallet', 'Check balances', "What's my balance?"),
      a('fu-buy', 'trade', 'Buy 100 USDT', 'Buy 100 USDT'),
      a('fu-node', 'node', 'Node health', 'How are my channels and node doing?'),
    ];
  }
  if (/swap|buy|sell|quote|trade|usdt|xaut|price/.test(p)) {
    return [
      a('fu-bal', 'wallet', 'Check balances', "What's my balance?"),
      a('fu-quote', 'trade', 'Quote another amount', 'Quote 50 USDT to BTC'),
      a('fu-chan', 'node', 'Check channels', 'How are my channels and node doing?'),
    ];
  }
  return [
    a('fu-bal', 'wallet', 'Check my balance', "What's my balance?"),
    a('fu-node', 'node', 'Node & channels', 'How are my channels and node doing?'),
    a('fu-opt', 'portfolio', 'Optimize portfolio', 'Review my portfolio allocation and suggest a rebalance'),
  ];
}

// ─────────────────────────────────────────────────────────────────────
// Tool confirmation — the human-in-the-loop gate for spends.
//
// When the agent wants a confirmation-gated tool, we emit a
// tool_confirm_request event; the desktop UI shows the call and answers
// with a tool_confirm command. No answer within the timeout ⇒ declined
// (fail closed, same as having no handler at all).
// ─────────────────────────────────────────────────────────────────────

const CONFIRM_TIMEOUT_MS = 120_000;
const pendingConfirms = new Map<string, (d: { approved: boolean; reason?: string }) => void>();

function requestToolConfirmation(call: {
  name: string;
  arguments: Record<string, unknown>;
}): Promise<{ approved: boolean; reason?: string }> {
  const confirmId = randomUUID();
  diag(`confirm requested: ${call.name} (${confirmId})`);
  emit({ type: 'tool_confirm_request', confirmId, call, timeoutMs: CONFIRM_TIMEOUT_MS });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingConfirms.delete(confirmId);
      diag(`confirm timed out: ${call.name} (${confirmId})`);
      resolve({ approved: false, reason: 'confirmation timed out' });
    }, CONFIRM_TIMEOUT_MS);
    pendingConfirms.set(confirmId, (d) => {
      clearTimeout(timer);
      pendingConfirms.delete(confirmId);
      diag(`confirm ${d.approved ? 'approved' : 'declined'}: ${call.name} (${confirmId})`);
      resolve(d);
    });
  });
}

/**
 * Keep conversational continuity without feeding huge opaque payment strings
 * back into every later prompt. Current-turn values still reach tools intact.
 */
function compactChatHistory(content: string): string {
  return content.replace(
    /\bln(?:bc|tb|bcrt)[0-9a-z]{40,}\b/gi,
    (invoice) => `[Lightning invoice omitted: ${invoice.slice(0, 10)}…${invoice.slice(-8)}]`,
  );
}

async function handleChat(
  prompt: string,
  chatId?: string,
): Promise<{
  text: string;
  thinking?: string;
  latencyMs: number;
  tokensPerSecond: number;
  /** Total tokens this turn (prompt + completion), summed across agentic calls. */
  tokens?: number;
  promptTokens?: number;
  /** The backend that actually ran this response. */
  device?: 'gpu' | 'cpu' | null;
  followups: SuggestedAction[];
}> {
  const t0 = Date.now();
  if (MOCK || !sdk || !state.qvacModelHandle) {
    await new Promise((r) => setTimeout(r, 320));
    return {
      text: `[MOCK reply] You said: "${prompt.slice(0, 60)}"`,
      latencyMs: Date.now() - t0,
      tokensPerSecond: 24,
      tokens: 48,
      promptTokens: 16,
      followups: followupActions(prompt),
    };
  }
  // Route through the shared @kaleido/mind Funnel — the SAME tiered agent the
  // mobile app runs (T0 fast-path → T2 recipe → T1 skill-scoped agentic).
  // Tool sources: kaleido-mcp (wallet/trading), bitrefill (commerce), and the
  // skill-reference reader. Tiers whose tools the registry doesn't implement
  // fall through to the agentic loop; with no sources connected the model
  // simply answers directly. Spend tools round-trip to the desktop UI for
  // explicit approval (tool_confirm_request / tool_confirm).
  const funnel = new Funnel({
    provider: qvacProvider,
    tools: new ToolRegistry(funnelSources()),
    skills: enabledSkills(),
    system: DESKTOP_SYSTEM,
    maxTurns: 4,
    getSettings: () => ({
      historyLength: 4,
      memoryEnabled: false,
      ragEnabled: false,
    }),
    log: (m) => diag(m),
    recipes: DESKTOP_RECIPES,
  });

  // Reset the per-turn reasoning buffer; the qvacProvider's onThinking appends
  // the model's <think> tokens to state.chatThinking as it streams.
  state.chatThinking = '';
  resetTurnStats();
  state.activeChatId = chatId ?? null;
  // Per-turn id source for tool events. The UI correlates a result back to its
  // running pill by tool NAME (onToolCall is fired fire-and-forget after an async
  // getDef, so a fast result can race ahead of its call) — the id is just a key.
  let toolSeq = 0;
  const statsSeqBefore = statsSeq;
  let res;
  try {
    res = await funnel.runTurn(prompt, {
      history: state.chatHistory,
      onConfirm: requestToolConfirmation,
      onToken: (token) => {
        if (state.activeChatId) {
          emit({ type: 'chat_content_delta', chatId: state.activeChatId, delta: token });
        }
      },
      // Surface tool activity so the desktop can render a live "running" pill and
      // then a typed result card (balance, channels, invoice, …) when it returns.
      onToolCall: (call, info) => {
        if (state.activeChatId) {
          emit({
            type: 'chat_tool_call',
            chatId: state.activeChatId,
            id: `${state.activeChatId}:${++toolSeq}`,
            name: call.name,
            arguments: call.arguments,
            requiresConfirmation: info.requiresConfirmation,
          });
        }
      },
      onToolResult: (ev) => {
        if (state.activeChatId) {
          const failed =
            !!ev.result &&
            typeof ev.result === 'object' &&
            'error' in (ev.result as Record<string, unknown>);
          emit({
            type: 'chat_tool_result',
            chatId: state.activeChatId,
            id: `${state.activeChatId}:${++toolSeq}`,
            name: ev.name,
            arguments: ev.arguments,
            ok: !failed,
            result: ev.result,
          });
        }
      },
    });
  } finally {
    state.activeChatId = null;
  }
  diag(`tier=${res.tier}`);
  if (res.tier === 'agentic') emit({ type: 'log', level: 'info', message: `agentic (${res.turns} turns)` });

  // Rolling context for follow-ups ("and how much is that in USD?") — the
  // Funnel trims it to its history budget each turn.
  const text = res.text || '(no response)';
  state.chatHistory.push(
    { role: 'user', content: compactChatHistory(prompt) },
    { role: 'assistant', content: compactChatHistory(text) },
  );

  const latencyMs = Date.now() - t0;
  // Prefer the SDK's real tok/s (set by onStats during the turn). Only fall back
  // to the char-count estimate when no model turn reported stats (e.g. a recipe
  // tier resolved deterministically without calling the model).
  if (statsSeq === statsSeqBefore) {
    const estimatedTokens = Math.max(1, Math.round((text.length + state.chatThinking.length) / 4));
    state.tokensPerSecond = Number((estimatedTokens / Math.max(latencyMs / 1000, 0.001)).toFixed(1));
  }
  emit(snapshot());

  return {
    text,
    thinking: state.chatThinking.trim() || undefined,
    latencyMs,
    // Prefer the latest QVAC tok/s for this turn; fall back to the rolling state.
    tokensPerSecond: turnStats.tps || (state.tokensPerSecond ?? 0),
    tokens: turnStats.totalTokens || undefined,
    promptTokens: turnStats.promptTokens || undefined,
    device: turnStats.device,
    // Contextual next-step cards the desktop renders under this reply.
    followups: followupActions(prompt),
  };
}

async function capabilities(): Promise<CapabilityInfo> {
  const skills = state.skills?.list() ?? [];
  const sources = [
    state.mcpSource,
    state.bitrefillSource,
    state.refSource,
    ...state.customMcpSources.values(),
  ].filter(Boolean) as ToolSource[];
  const tools = await new ToolRegistry(sources).listTools();
  const mcpServers: CapabilityInfo['mcpServers'] = [];
  for (const server of state.customMcpServers.values()) {
    const source = state.customMcpSources.get(server.id);
    const serverTools = source ? await source.listTools() : [];
    mcpServers.push({
      ...server,
      connected: !!source,
      toolCount: serverTools.length,
      ...(state.customMcpErrors.has(server.id) ? { error: state.customMcpErrors.get(server.id) } : {}),
    });
  }
  return {
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      enabled: !state.disabledSkills.has(skill.name),
      tools: skill.tools ?? [],
    })),
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      requiresConfirmation: !!tool.requiresConfirmation,
    })),
    mcpConnected: state.mcpSource != null,
    mcpServers,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────────────

async function dispatch(cmd: Command): Promise<void> {
  try {
    switch (cmd.cmd) {
      case 'ping':
        respondOk(cmd.id, { pong: true });
        break;
      case 'get_status':
        respondOk(cmd.id, snapshot());
        break;
      case 'start':
        await handleStart(cmd.modelId);
        respondOk(cmd.id, snapshot());
        break;
      case 'stop':
        await handleStop();
        respondOk(cmd.id);
        break;
      case 'list_installed_models':
        respondOk(cmd.id, await listInstalledModels());
        break;
      case 'list_catalog_models':
        respondOk(cmd.id, await allCatalog());
        break;
      case 'add_huggingface_model': {
        const model = await addCustomModel(cmd.url, cmd.displayName);
        respondOk(cmd.id, model);
        handleDownload(model.id).catch((e) => emit({ type: 'log', level: 'error', message: String(e) }));
        break;
      }
      case 'download_model':
        respondOk(cmd.id);              // ack immediately, progress streams as events
        handleDownload(cmd.modelId).catch((e) => emit({ type: 'log', level: 'error', message: String(e) }));
        break;
      case 'cancel_download':
        handleCancelDownload(cmd.modelId);
        respondOk(cmd.id);
        break;
      case 'delete_model':
        await handleDeleteModel(cmd.modelId);
        respondOk(cmd.id);
        break;
      case 'set_active_model':
        await handleSetActiveModel(cmd.modelId);
        respondOk(cmd.id);
        break;
      case 'chat':
        respondOk(cmd.id, await handleChat(cmd.prompt, cmd.chatId));
        break;
      case 'add_skill':
        await addSkill(cmd.name, cmd.description, cmd.instructions, cmd.tools);
        respondOk(cmd.id, await capabilities());
        break;
      case 'delete_skill':
        await deleteSkill(cmd.name);
        respondOk(cmd.id, await capabilities());
        break;
      case 'list_capabilities':
        respondOk(cmd.id, await capabilities());
        break;
      case 'set_skill_enabled':
        if (cmd.enabled) state.disabledSkills.delete(cmd.name);
        else state.disabledSkills.add(cmd.name);
        await saveProviderSettings();
        respondOk(cmd.id, await capabilities());
        break;
      case 'add_mcp_server':
        await addMcpServer(cmd.name, cmd.url);
        respondOk(cmd.id, await capabilities());
        break;
      case 'remove_mcp_server':
        await removeMcpServer(cmd.serverId);
        respondOk(cmd.id, await capabilities());
        break;
      case 'tool_confirm': {
        const resolve = pendingConfirms.get(cmd.confirmId);
        if (resolve) {
          resolve({ approved: cmd.approved, reason: cmd.reason });
          respondOk(cmd.id, { received: true });
        } else {
          // Already timed out (declined) or unknown — harmless, just say so.
          respondOk(cmd.id, { received: false, stale: true });
        }
        break;
      }
      case 'forget_peer':
        state.peers.delete(cmd.shortKey);
        emit({ type: 'peer_disconnected', shortKey: cmd.shortKey });
        respondOk(cmd.id);
        break;
      case 'list_tasks':
        respondOk(cmd.id, await taskStore.list());
        break;
      case 'create_task': {
        const created = await taskStore.create(cmd.task);
        await emitTasksChanged();
        respondOk(cmd.id, created);
        break;
      }
      case 'update_task': {
        const updated = await taskStore.update(cmd.taskId, cmd.patch);
        await emitTasksChanged();
        respondOk(cmd.id, updated);
        break;
      }
      case 'delete_task': {
        const removed = await taskStore.remove(cmd.taskId);
        await emitTasksChanged();
        respondOk(cmd.id, { removed });
        break;
      }
      case 'run_task':
        // runNow fires the run + emits started/finished via onOutcome.
        respondOk(cmd.id, await scheduler.runNow(cmd.taskId));
        break;
      case 'set_scheduler': {
        schedulerRunning = cmd.running;
        await saveProviderSettings();
        if (cmd.running) startScheduler();
        else stopScheduler();
        const info = await agentStateInfo();
        emit({ type: 'agent_state', state: info });
        respondOk(cmd.id, info);
        break;
      }
      case 'get_agent_state':
        respondOk(cmd.id, await agentStateInfo());
        break;
      case 'set_risk_limits': {
        riskLimits = { ...riskLimits, ...cmd.limits };
        await saveProviderSettings();
        const info = await agentStateInfo();
        emit({ type: 'agent_state', state: info });
        respondOk(cmd.id, info);
        break;
      }
      case 'set_portfolio_targets': {
        portfolioTargets = { ...portfolioTargets, ...cmd.targets };
        await saveProviderSettings();
        const info = await agentStateInfo();
        emit({ type: 'agent_state', state: info });
        respondOk(cmd.id, info);
        break;
      }
      case 'set_generation_limits': {
        if (cmd.maxThinkingTokens !== undefined) {
          maxThinkingTokens = cmd.maxThinkingTokens > 0 ? cmd.maxThinkingTokens : undefined;
        }
        if (cmd.maxOutputTokens !== undefined) {
          maxOutputTokens = cmd.maxOutputTokens > 0 ? cmd.maxOutputTokens : undefined;
        }
        await saveProviderSettings();
        const info = await agentStateInfo();
        emit({ type: 'agent_state', state: info });
        respondOk(cmd.id, info);
        break;
      }
      case 'get_suggested_actions':
        respondOk(cmd.id, suggestedActions());
        break;
      case 'shutdown':
        respondOk(cmd.id);
        await shutdownProvider('shutdown command');
        return;
      default: {
        const exhaustive: never = cmd;
        respondErr((exhaustive as Command).id, `Unknown cmd: ${(exhaustive as Command).cmd}`);
      }
    }
  } catch (e) {
    respondErr(cmd.id, e instanceof Error ? e.message : String(e));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Mock helper — stable-looking pubkey for offline dev
// ─────────────────────────────────────────────────────────────────────

function mockPubkey(): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 64; i++) out += hex[Math.floor(Math.random() * 16)];
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────

let providerShuttingDown = false;

async function shutdownProvider(reason: string): Promise<void> {
  if (providerShuttingDown) return;
  providerShuttingDown = true;
  diag(`${reason} — shutting down`);
  await handleStop();
  if (sdk?.close) {
    try { await sdk.close(); } catch {}
  }
  process.exit(0);
}

async function main(): Promise<void> {
  await loadProviderSettings();
  loadSkills();
  // Seed the default loops (heartbeat / rebalance / daily summary) — all
  // disabled until the user arms them. Idempotent across restarts.
  await taskStore.seedDefaults(defaultTaskSeeds());
  await loadSdk();
  emit({ type: 'ready', version: '0.0.1' });
  emit(snapshot());
  void connectSavedMcps();
  void emitTasksChanged();

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const cmd = decodeCommand(trimmed);
    if (!cmd) {
      diag(`bad line: ${trimmed.slice(0, 120)}`);
      return;
    }
    dispatch(cmd).catch((e) => diag(`dispatch error: ${(e as Error).message}`));
  });

  // The desktop app owns this process through stdin. If it is restarted,
  // crashes, or is force-closed, the pipe closes; exit instead of leaving a
  // QVAC worker behind holding the model lock.
  rl.on('close', () => void shutdownProvider('stdin closed'));
  process.on('SIGTERM', () => void shutdownProvider('SIGTERM'));
  process.on('SIGINT', () => void shutdownProvider('SIGINT'));
}

main().catch((e) => {
  emit({ type: 'fatal', error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
