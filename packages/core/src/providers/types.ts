/**
 * LLMProvider — the only thing the Engine talks to for inference.
 *
 * Each host implements this over its own LLM transport:
 *   - QVAC on-device (rate, desktop sidecar, CLI): `@kaleidorg/mind/qvac`
 *   - any OpenAI-compatible server (Ollama, LM Studio, hosted APIs):
 *     `@kaleidorg/mind/openai`
 *
 * The core package never imports any LLM SDK — it only depends on this
 * interface, so it stays pure TS and bundles anywhere.
 */

import type { Message, ToolCall, ToolDef } from '../types.js';

export interface TurnInput {
  messages: Message[];
  tools: ToolDef[];
  /** System prompt, when not already present as a message. */
  system?: string;
  /**
   * `'required'` forces a tool call, a tool name forces that tool, `'none'`
   * forbids tools. Omit for the model's own choice. Ignored when `tools` is
   * empty or the provider has no such control.
   */
  toolChoice?: ToolChoice;
  /**
   * `'off'` asks the provider to skip reasoning for this turn (e.g. a forced
   * tool call). Ignored by providers without reasoning control.
   */
  thinking?: 'off';
  /**
   * Same value on every call of one agentic run, whose history only grows.
   * Providers with a session cache (QVAC `kvCache`) can then send only the new
   * message instead of the whole prompt.
   */
  sessionKey?: string;
  /** Visible content tokens as they stream. */
  onToken?: (token: string) => void;
  signal?: AbortSignal;
}

export type ToolChoice = 'auto' | 'none' | 'required' | (string & {});

/** A tool-call region the model emitted that the provider could not turn into a call. */
export interface ToolCallError {
  code: 'PARSE_ERROR' | 'VALIDATION_ERROR' | 'UNKNOWN_TOOL' | (string & {});
  message: string;
  raw?: string;
}

/** Judge-auditable metrics for one provider inference request. */
export interface InferenceMetrics {
  requestId?: string;
  backendDevice?: 'cpu' | 'gpu';
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Milliseconds from completion() start to the first generated delta. */
  ttftMs?: number;
  /** End-to-end completion duration measured by the host. */
  durationMs: number;
  tokensPerSecond?: number;
  stopReason?: string;
  status: 'completed' | 'cancelled' | 'truncated' | 'failed';
}

export interface TurnOutput {
  /** Cleaned assistant content for display. */
  text: string;
  /**
   * Raw assistant frame to push back into history for the next turn. For
   * tool-calling models this includes the tool-call framing the model needs
   * to anchor continuation (e.g. QVAC's `final.raw.fullText`). Falls back to
   * `text` when a provider has no separate raw form.
   */
  rawContent: string;
  /** Tool calls the model requested this turn (empty ⇒ final answer). */
  toolCalls: ToolCall[];
  /** Tool-call attempts that failed to parse or validate this turn. */
  toolErrors?: ToolCallError[];
  /** Provider request id, for cancellation. */
  requestId?: string;
  /** Optional local-inference receipt. Hosts may persist this as JSONL evidence. */
  inference?: InferenceMetrics;
  /**
   * True when the turn produced no visible answer because it ran out of budget
   * (e.g. reasoning used the whole output cap). `text` may hold a placeholder.
   */
  incomplete?: boolean;
}

export interface LLMProvider {
  readonly name: string;
  /** Run one completion turn. */
  runTurn(input: TurnInput): Promise<TurnOutput>;
  /** Drop whatever the provider cached for `sessionKey` (end of an agentic run). */
  endSession?(sessionKey: string): Promise<void>;
  /** Cancel an in-flight turn by request id, if the provider supports it. */
  cancel?(requestId: string): Promise<void>;
}
