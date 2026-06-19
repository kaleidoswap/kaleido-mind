// apps/provider/src/protocol.ts
//
// Wire protocol between the Tauri Rust supervisor and this Node sidecar.
// One JSON object per line. UTF-8.
//
// Direction: Tauri → sidecar (commands on stdin)
//            Sidecar → Tauri (events + responses on stdout)
// stderr is reserved for human-readable diagnostics, never parsed.

// ───────────────────────────────────────────────────────────────────────
// Autonomy wire types — the agent's task brain (mirror @kaleidorg/mind/autonomy).
// Structurally compatible with the core types so the sidecar passes core
// objects straight onto the wire; the frontend mirrors these in api/mind.ts.
// ───────────────────────────────────────────────────────────────────────

export interface TaskAllocationWire {
  btcSat: number;
  usdt: number;
  xaut: number;
}

export interface AgentTaskWire {
  id: string;
  name: string;
  description: string;
  skill: string;
  scheduleSec: number;
  runOnStartup: boolean;
  allocation: TaskAllocationWire;
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
}

export interface RiskLimitsWire {
  dryRun: boolean;
  minBtcReserveSat: number;
  stopLossBtcSat: number;
  maxSpendUsd: number;
  autoApproveUnderUsd: number;
  maxOpenOrders?: number;
}

/** Target portfolio weights the rebalance loop steers toward (percent). */
export interface PortfolioTargetsWire {
  btcPct: number;
  usdtPct: number;
  xautPct: number;
  /** Rebalance only when an asset drifts more than this many points from target. */
  driftThresholdPct: number;
}

export interface TaskRunCostWire {
  usd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface TaskStatsWire {
  runs: number;
  errors: number;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastToolCalls: number | null;
  lastError: string | null;
  lastText: string | null;
}

export interface TaskRunRecordWire {
  taskId: string;
  taskName: string;
  startedAt: number;
  durationMs: number;
  toolCalls: number;
  ok: boolean;
  error: string | null;
  text: string;
  cost: TaskRunCostWire;
}

export interface AgentStateWire {
  schedulerRunning: boolean;
  risk: RiskLimitsWire;
  targets: PortfolioTargetsWire;
  /** Generation token caps (0 ⇒ uncapped). */
  generation: { maxThinkingTokens: number; maxOutputTokens: number };
  recent: TaskRunRecordWire[];
  stats: Record<string, TaskStatsWire>;
  cumulative: TaskRunCostWire;
}

/** What `create_task` accepts. */
export interface NewTaskInput {
  name: string;
  description: string;
  skill: string;
  scheduleSec: number;
  enabled: boolean;
  runOnStartup?: boolean;
  allocation?: TaskAllocationWire;
  id?: string;
}

/** What `update_task` patches (all optional; id/createdAt immutable). */
export interface TaskPatchInput {
  name?: string;
  description?: string;
  skill?: string;
  scheduleSec?: number;
  runOnStartup?: boolean;
  allocation?: TaskAllocationWire;
  enabled?: boolean;
}

/** A one-tap starter the chat renders as a card on the empty/first screen. */
export interface SuggestedAction {
  id: string;
  /** 'wallet' | 'node' | 'portfolio' | 'trade' — the UI maps these to an icon. */
  icon: string;
  title: string;
  subtitle: string;
  /** The chat prompt this card sends when tapped. */
  prompt: string;
}

// ───────────────────────────────────────────────────────────────────────
// Commands (Tauri → sidecar)
// ───────────────────────────────────────────────────────────────────────

export type Command =
  | { id: string; cmd: 'ping' }
  | { id: string; cmd: 'get_status' }
  | { id: string; cmd: 'start'; modelId: string }
  | { id: string; cmd: 'stop' }
  | { id: string; cmd: 'list_installed_models' }
  | { id: string; cmd: 'list_catalog_models' }
  | { id: string; cmd: 'download_model'; modelId: string }
  | { id: string; cmd: 'add_huggingface_model'; url: string; displayName?: string }
  | { id: string; cmd: 'cancel_download'; modelId: string }
  | { id: string; cmd: 'delete_model'; modelId: string }
  | { id: string; cmd: 'set_active_model'; modelId: string }
  | { id: string; cmd: 'chat'; prompt: string; chatId?: string }
  | { id: string; cmd: 'add_skill'; name: string; description: string; instructions: string; tools?: string[] }
  | { id: string; cmd: 'delete_skill'; name: string }
  | { id: string; cmd: 'list_capabilities' }
  | { id: string; cmd: 'set_skill_enabled'; name: string; enabled: boolean }
  | { id: string; cmd: 'add_mcp_server'; name: string; url: string }
  | { id: string; cmd: 'remove_mcp_server'; serverId: string }
  | { id: string; cmd: 'tool_confirm'; confirmId: string; approved: boolean; reason?: string }
  | { id: string; cmd: 'forget_peer'; shortKey: string }
  // ── Autonomy (the agent's task brain) ──
  | { id: string; cmd: 'list_tasks' }
  | { id: string; cmd: 'create_task'; task: NewTaskInput }
  | { id: string; cmd: 'update_task'; taskId: string; patch: TaskPatchInput }
  | { id: string; cmd: 'delete_task'; taskId: string }
  | { id: string; cmd: 'run_task'; taskId: string }
  | { id: string; cmd: 'set_scheduler'; running: boolean }
  | { id: string; cmd: 'get_agent_state' }
  | { id: string; cmd: 'set_risk_limits'; limits: Partial<RiskLimitsWire> }
  | { id: string; cmd: 'set_portfolio_targets'; targets: Partial<PortfolioTargetsWire> }
  // Token caps (0 ⇒ uncapped); read live each turn — no restart needed.
  | { id: string; cmd: 'set_generation_limits'; maxThinkingTokens?: number; maxOutputTokens?: number }
  | { id: string; cmd: 'get_suggested_actions' }
  | { id: string; cmd: 'shutdown' };

// ───────────────────────────────────────────────────────────────────────
// Events (sidecar → Tauri)
// ───────────────────────────────────────────────────────────────────────

export interface ProviderStatusEvent {
  type: 'status';
  on: boolean;
  publicKey: string | null;
  activeModelId: string | null;
  activeModelName: string | null;
  peers: PeerInfo[];
  tokensPerSecond: number | null;
  startedAt: number | null;
  inferenceDevice?: 'gpu' | 'cpu' | 'mock' | null;
  /** Whisper model loaded — phones can delegate speech-to-text to this provider. */
  sttReady?: boolean;
  /** TTS model loaded — phones can delegate text-to-speech to this provider. */
  ttsReady?: boolean;
}

export interface CapabilityInfo {
  skills: Array<{ name: string; description: string; enabled: boolean; tools: string[] }>;
  tools: Array<{ name: string; description: string; requiresConfirmation: boolean }>;
  mcpConnected: boolean;
  mcpServers: Array<{ id: string; name: string; url: string; connected: boolean; toolCount: number; error?: string }>;
}

export interface PeerInfo {
  shortKey: string;
  label: string;
  connectedAt: number;
  lastActiveAt: number;
}

export interface InstalledModel {
  id: string;
  family: string;
  displayName: string;
  sizeBytes: number;
  path: string;
  active: boolean;
}

export interface CatalogModel {
  id: string;
  family: string;
  displayName: string;
  quant: string;
  sizeBytes: number;
  hfRepo: string;
  hfFile: string;
  ramHintGb: number;
  notes?: string;
}

export interface DownloadProgress {
  modelId: string;
  bytesDownloaded: number;
  bytesTotal: number;
  percentage: number;
}

export type ProviderLoadingPhase =
  | 'loading_model'
  | 'model_loaded'
  | 'starting_p2p'
  | 'ready'
  | 'p2p_failed'
  | 'aborted';

export interface ProviderLoadingEvent {
  type: 'provider_loading';
  phase: ProviderLoadingPhase;
  percentage?: number;     // 0–100, present on loading_model
  message?: string;
}

/**
 * The agent wants to run a confirmation-gated tool (a spend). The host UI
 * must show the call and answer with a `tool_confirm` command within
 * `timeoutMs`, or the sidecar declines it (fail closed).
 */
export interface ToolConfirmRequestEvent {
  type: 'tool_confirm_request';
  confirmId: string;
  call: { name: string; arguments: Record<string, unknown> };
  timeoutMs: number;
}

export type Event =
  | { type: 'ready'; version: string }
  | ProviderStatusEvent
  | ProviderLoadingEvent
  | ToolConfirmRequestEvent
  | { type: 'pubkey'; value: string }
  | { type: 'peer_connected'; peer: PeerInfo }
  | { type: 'peer_disconnected'; shortKey: string }
  | { type: 'download_progress'; progress: DownloadProgress }
  | { type: 'download_completed'; modelId: string }
  | { type: 'chat_thinking_delta'; chatId: string; delta: string }
  | { type: 'chat_content_delta'; chatId: string; delta: string }
  | { type: 'chat_tool_call'; chatId: string; id: string; name: string; arguments: Record<string, unknown>; requiresConfirmation?: boolean }
  | { type: 'chat_tool_result'; chatId: string; id: string; name: string; arguments: Record<string, unknown>; ok: boolean; result: unknown }
  | { type: 'capabilities_changed'; capabilities: CapabilityInfo }
  // ── Autonomy events ──
  | { type: 'tasks_changed'; tasks: AgentTaskWire[] }
  | { type: 'task_run_started'; taskId: string; taskName: string; at: number }
  | { type: 'task_run_finished'; record: TaskRunRecordWire }
  | { type: 'agent_state'; state: AgentStateWire }
  // A proactive, unprompted message from the agent (e.g. a task result/alert)
  // the desktop appends to the chat as an assistant turn.
  | { type: 'agent_message'; text: string; taskId?: string; taskName?: string; at: number }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'response'; id: string; ok: true; data?: unknown }
  | { type: 'response'; id: string; ok: false; error: string }
  | { type: 'fatal'; error: string };

// ───────────────────────────────────────────────────────────────────────
// Helpers — stable string forms for stdio
// ───────────────────────────────────────────────────────────────────────

export function encodeEvent(e: Event): string {
  return JSON.stringify(e) + '\n';
}

export function decodeCommand(line: string): Command | null {
  try {
    const obj = JSON.parse(line);
    if (typeof obj === 'object' && obj && typeof obj.id === 'string' && typeof obj.cmd === 'string') {
      return obj as Command;
    }
    return null;
  } catch {
    return null;
  }
}
