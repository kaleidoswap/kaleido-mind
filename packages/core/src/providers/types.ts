/**
 * LLMProvider — the only thing the Engine talks to for inference.
 *
 * Each host implements this over its own LLM transport:
 *   - rate (mobile): wraps @qvac/sdk completion() (local or P2P-delegated)
 *   - desktop-app:   wraps @qvac/sdk completion() in Node
 *   - kaleidoagent:  could wrap Anthropic/OpenAI
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
  /** Visible content tokens as they stream. */
  onToken?: (token: string) => void;
  signal?: AbortSignal;
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
  /** Provider request id, for cancellation. */
  requestId?: string;
  /** Optional local-inference receipt. Hosts may persist this as JSONL evidence. */
  inference?: InferenceMetrics;
}

export interface LLMProvider {
  readonly name: string;
  /** Run one completion turn. */
  runTurn(input: TurnInput): Promise<TurnOutput>;
  /** Cancel an in-flight turn by request id, if the provider supports it. */
  cancel?(requestId: string): Promise<void>;
}
