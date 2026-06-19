// apps/provider/src/protocol.ts
//
// Wire protocol between the Tauri Rust supervisor and this Node sidecar.
// One JSON object per line. UTF-8.
//
// Direction: Tauri → sidecar (commands on stdin)
//            Sidecar → Tauri (events + responses on stdout)
// stderr is reserved for human-readable diagnostics, never parsed.

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
  | { id: string; cmd: 'add_huggingface_model'; repo: string; file: string; displayName?: string }
  | { id: string; cmd: 'cancel_download'; modelId: string }
  | { id: string; cmd: 'delete_model'; modelId: string }
  | { id: string; cmd: 'set_active_model'; modelId: string }
  | { id: string; cmd: 'chat'; prompt: string }
  | { id: string; cmd: 'list_capabilities' }
  | { id: string; cmd: 'set_skill_enabled'; name: string; enabled: boolean }
  | { id: string; cmd: 'add_mcp_server'; name: string; url: string }
  | { id: string; cmd: 'remove_mcp_server'; serverId: string }
  | { id: string; cmd: 'tool_confirm'; confirmId: string; approved: boolean; reason?: string }
  | { id: string; cmd: 'forget_peer'; shortKey: string }
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
  | { type: 'capabilities_changed'; capabilities: CapabilityInfo }
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
