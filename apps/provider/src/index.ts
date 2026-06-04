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
  Engine,
  ToolRegistry,
  SkillRegistry,
  createSkillReferenceToolSource,
  type LLMProvider,
  type ToolSource,
} from '@kaleidorg/mind';
import { loadSkillsDir, packagedSkillsDir } from '@kaleidorg/mind/skills';

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
  startQVACProvider: (opts?: any) => Promise<any>;
  stopQVACProvider: () => Promise<void>;
  heartbeat?: (opts?: any) => Promise<unknown>;
  close: () => Promise<void>;
}

let sdk: QvacSDK | null = null;
let MOCK = false;

async function loadSdk(): Promise<void> {
  try {
    sdk = (await import('@qvac/sdk')) as unknown as QvacSDK;
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
  peers: new Map<string, PeerInfo>(),
  startedAt: null as number | null,
  tokensPerSecond: null as number | null,
  mcpSource: null as ToolSource | null,            // kaleido-mcp tools, when configured
  bitrefillSource: null as ToolSource | null,      // bitrefill remote MCP, when enabled
  skills: null as SkillRegistry | null,            // Agent Skills (loaded from skills/)
  refSource: null as ToolSource | null,            // read_skill_reference (progressive disclosure)
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

const qvacProvider: LLMProvider = {
  name: 'qvac',
  async runTurn(input) {
    if (!sdk || !state.qvacModelHandle) throw new Error('model not loaded');
    const history = input.system
      ? [{ role: 'system', content: input.system }, ...input.messages]
      : input.messages;
    const toolDefs = input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    const run: any = sdk.completion({
      modelId: state.qvacModelHandle,
      history,
      stream: true,
      tools: toolDefs.length ? toolDefs : undefined,
    });
    let streamed = '';
    if (run?.events) {
      for await (const ev of run.events) {
        if (ev?.type === 'contentDelta') {
          streamed += ev.text;
          input.onToken?.(ev.text);
        }
      }
    }
    const final = run?.final ? await run.final : null;
    // Strip <think>…</think> reasoning blocks from the user-visible text;
    // keep the raw frame (with framing) for history push-back.
    const rawText = final?.contentText || streamed || '';
    const text = rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return {
      text,
      rawContent: final?.raw?.fullText ?? rawText,
      toolCalls: (final?.toolCalls || []).map((c: any) => ({
        id: c.id,
        name: c.name,
        arguments: c.arguments ?? {},
      })),
      requestId: run?.requestId,
    };
  },
};

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

async function handleStart(modelId: string): Promise<void> {
  if (state.providerOn) {
    throw new Error('Provider is already running. Stop it first.');
  }
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
    emit({ type: 'provider_loading', phase: 'starting_p2p', message: 'Connecting to Hyperswarm…' });

    // 60 s ceiling on the P2P bootstrap — DHT can take ~30s on first run.
    let provider: any = null;
    try {
      provider = await withTimeout(sdk.startQVACProvider({}), 60_000);
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

async function handleChat(prompt: string): Promise<{ text: string; latencyMs: number; tokensPerSecond: number }> {
  const t0 = Date.now();
  if (MOCK || !sdk || !state.qvacModelHandle) {
    await new Promise((r) => setTimeout(r, 320));
    return {
      text: `[MOCK reply] You said: "${prompt.slice(0, 60)}"`,
      latencyMs: Date.now() - t0,
      tokensPerSecond: 24,
    };
  }
  // Route through the shared @kaleido/mind engine — same agentic loop as mobile.
  // Tool sources: kaleido-mcp (wallet/trading), bitrefill (commerce), and the
  // skill-reference reader. With none connected the engine simply returns the
  // model's direct answer.
  const sources: ToolSource[] = [
    state.mcpSource,
    state.bitrefillSource,
    state.refSource,
  ].filter(Boolean) as ToolSource[];

  // Enter the most relevant skill: its playbook is composed into the system
  // prompt and (when it scopes tools) only those tools are exposed.
  const skill = state.skills?.select(prompt) ?? null;
  const composed = state.skills?.compose(DESKTOP_SYSTEM, skill) ?? { system: DESKTOP_SYSTEM };
  if (skill) {
    diag(`skill selected: ${skill.name}`);
    emit({ type: 'log', level: 'info', message: `skill: ${skill.name}` });
  }

  const engine = new Engine({
    provider: qvacProvider,
    tools: new ToolRegistry(sources),
    defaultSystem: composed.system,
    defaultMaxTurns: 8,
  });
  const res = await engine.runAgentic([{ role: 'user', content: prompt }], {
    allowedTools: composed.allowedTools,
  });
  return {
    text: res.text || '(no response)',
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
