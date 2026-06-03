/**
 * Core types for the kaleido-mind engine.
 *
 * Pure data shapes — no runtime dependencies. The engine, tool sources and
 * providers are all defined in terms of these, so the core package bundles
 * cleanly on any host (React Native / Node / browser) without dragging in
 * @qvac/sdk or any native code.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string;
}

/**
 * A tool the model can call. `parameters` is intentionally `unknown` — it may
 * be a Zod schema (in-process tools) or a JSON Schema (MCP tools). Each
 * provider converts it to whatever its SDK expects.
 */
export interface ToolDef {
  name: string;
  description: string;
  parameters: unknown;
  /** When true, the engine pauses for `onConfirm` before executing (e.g. payments). */
  requiresConfirmation?: boolean;
}

export interface ToolCall {
  /** Provider-assigned id, when available. */
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface ConfirmDecision {
  approved: boolean;
  reason?: string;
}
