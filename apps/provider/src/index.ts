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
  type CatalogModel,
  type Command,
  type Event,
  type InstalledModel,
  type PeerInfo,
  type ProviderStatusEvent,
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
  assetSendRecipe,
  paymentsRecipe,
  receiveRecipe,
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
  mcpSource: null as ToolSource | null,            // kaleido-mcp tools, when configured
  bitrefillSource: null as ToolSource | null,      // bitrefill remote MCP, when enabled
  skills: null as SkillRegistry | null,            // Agent Skills (loaded from skills/)
  refSource: null as ToolSource | null,            // read_skill_reference (progressive disclosure)
  chatHistory: [] as Message[],                    // rolling conversation (trimmed by the Funnel)
  chatThinking: '',                                // current turn's <think> reasoning (surfaced to the UI)
};

// ─────────────────────────────────────────────────────────────────────
// Shared @kaleido/mind engine — the SAME agentic loop the mobile app runs.
// Provider wraps @qvac/sdk completion; tools come from kaleido-mcp (when
// KALEIDO_MCP_PATH is set), else the desktop chats tool-less.
// ─────────────────────────────────────────────────────────────────────

const DESKTOP_SYSTEM =
  'You are KaleidoMind, a local-first AI for Bitcoin, Lightning and RGB running on the user\'s desktop. ' +
  'Use the available tools to take actions and answer questions; never invent balances, addresses or data — ' +
  'always call a tool and report what it returns. Keep replies concise.';

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
  // Accumulate the model's <think> reasoning for the current chat turn so the
  // desktop UI can show it (collapsed by default). Reset per turn in handleChat.
  onThinking: (token: string) => {
    state.chatThinking += token;
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
  if (state.skills) return;
  const dir = process.env.KALEIDO_SKILLS_DIR ?? packagedSkillsDir();
  try {
    const skills = loadSkillsDir(dir);
    if (!skills.length) {
      diag(`no skills found in ${dir}`);
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
    sttReady: state.qvacSttHandle != null,
    ttsReady: state.qvacTtsHandle != null,
  };
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
  const installed: InstalledModel[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.gguf')) continue;
    const match = CATALOG.find((c) => c.hfFile === entry);
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
        modelConfig: { ctx_size: 16384, tools: true },
        onProgress: (p: { percentage: number }) => {
          diag(`load progress: ${p.percentage}%`);
          emit({ type: 'provider_loading', phase: 'loading_model', percentage: p.percentage });
        },
      });
    } catch (e) {
      emit({ type: 'provider_loading', phase: 'aborted', message: `Failed to load model: ${(e as Error).message}` });
      throw new Error(`load failed: ${(e as Error).message}`);
    }

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

  if (state.publicKey) emit({ type: 'pubkey', value: state.publicKey });
  emit({ type: 'provider_loading', phase: 'ready' });
  emit(snapshot());
}

async function handleStop(): Promise<void> {
  if (!state.providerOn) return;
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

  const model = CATALOG.find((c) => c.id === modelId);
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
    if (stat.size >= model.sizeBytes * 0.99) {
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

async function handleChat(
  prompt: string,
): Promise<{ text: string; thinking?: string; latencyMs: number; tokensPerSecond: number }> {
  const t0 = Date.now();
  if (MOCK || !sdk || !state.qvacModelHandle) {
    await new Promise((r) => setTimeout(r, 320));
    return {
      text: `[MOCK reply] You said: "${prompt.slice(0, 60)}"`,
      latencyMs: Date.now() - t0,
      tokensPerSecond: 24,
    };
  }
  // Route through the shared @kaleido/mind Funnel — the SAME tiered agent the
  // mobile app runs (T0 fast-path → T2 recipe → T1 skill-scoped agentic).
  // Tool sources: kaleido-mcp (wallet/trading), bitrefill (commerce), and the
  // skill-reference reader. Tiers whose tools the registry doesn't implement
  // fall through to the agentic loop; with no sources connected the model
  // simply answers directly. Spend tools round-trip to the desktop UI for
  // explicit approval (tool_confirm_request / tool_confirm).
  const sources: ToolSource[] = [
    state.mcpSource,
    state.bitrefillSource,
    state.refSource,
  ].filter(Boolean) as ToolSource[];

  const funnel = new Funnel({
    provider: qvacProvider,
    tools: new ToolRegistry(sources),
    skills: state.skills?.list() ?? [],
    system: DESKTOP_SYSTEM,
    maxTurns: 8,
    log: (m) => diag(m),
    // Opt-in recipes (buy-asset-channel onboarding + atomic swap) drive the
    // kaleidoswap_*/rln_* MCP tools, so they fire on desktop; the generic
    // payments/receive/asset-send defaults stay registered too. A recipe only
    // fires when its deterministic extractor is confident AND the MCP registry
    // implements its final tool, so unmatched ones fall through to the agent.
    recipes: [
      buyAssetChannelRecipe,
      kaleidoswapAtomicRecipe,
      assetSendRecipe,
      paymentsRecipe,
      receiveRecipe,
    ],
  });

  // Reset the per-turn reasoning buffer; the qvacProvider's onThinking appends
  // the model's <think> tokens to state.chatThinking as it streams.
  state.chatThinking = '';
  const res = await funnel.runTurn(prompt, {
    history: state.chatHistory,
    onConfirm: requestToolConfirmation,
  });
  diag(`tier=${res.tier}`);
  if (res.tier === 'agentic') emit({ type: 'log', level: 'info', message: `agentic (${res.turns} turns)` });

  // Rolling context for follow-ups ("and how much is that in USD?") — the
  // Funnel trims it to its history budget each turn.
  const text = res.text || '(no response)';
  state.chatHistory.push({ role: 'user', content: prompt }, { role: 'assistant', content: text });

  return {
    text,
    thinking: state.chatThinking.trim() || undefined,
    latencyMs: Date.now() - t0,
    tokensPerSecond: state.tokensPerSecond ?? 0,
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
        respondOk(cmd.id, CATALOG);
        break;
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
        respondOk(cmd.id, await handleChat(cmd.prompt));
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
      case 'shutdown':
        respondOk(cmd.id);
        await handleStop();
        if (sdk?.close) {
          try { await sdk.close(); } catch {}
        }
        process.exit(0);
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

async function main(): Promise<void> {
  await loadSdk();
  emit({ type: 'ready', version: '0.0.1' });
  emit(snapshot());

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

  process.on('SIGTERM', async () => {
    diag('SIGTERM — shutting down');
    await handleStop();
    process.exit(0);
  });
}

main().catch((e) => {
  emit({ type: 'fatal', error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
