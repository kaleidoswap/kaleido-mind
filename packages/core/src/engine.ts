/**
 * Engine — the agentic loop, provider- and tool-source-agnostic.
 *
 * This is the shared "brain" logic, lifted out of rate's QVACService so the
 * mobile app, the desktop app and the agent all run the SAME loop:
 *
 *   reason → (tool calls?) → execute / confirm → feed results back → repeat
 *   → natural-language answer.
 *
 * Follows the QVAC multi-turn pattern: push the raw assistant frame plus
 * `{role:'tool'}` results into history each round, loop until the model stops
 * calling tools. Money tools pause for an `onConfirm` gate; their handlers run
 * wherever the ToolSource lives (on the phone for the wallet), even when
 * inference is delegated to a remote provider.
 */

import type { ConfirmDecision, Message, ToolResult } from './types.js';
import type { LLMProvider } from './providers/types.js';
import type { ToolRegistry } from './tools/registry.js';

export interface EngineOptions {
  provider: LLMProvider;
  tools: ToolRegistry;
  /** Prepended as a system message when the caller didn't supply one. */
  defaultSystem?: string;
  /** Max reasoning↔tool rounds before forcing a stop. Default 5. */
  defaultMaxTurns?: number;
}

export interface AgenticOptions {
  maxTurns?: number;
  /** Visible content tokens as they stream, tagged with the current turn. */
  onToken?: (token: string, turn: number) => void;
  /** The live requestId for the current turn (so a stop button can cancel it). */
  onStart?: (requestId: string, turn: number) => void;
  /** Fired when the model requests a tool, before it executes. */
  onToolCall?: (call: { name: string; arguments: Record<string, unknown> }, turn: number) => void;
  /** Human-in-the-loop gate for tools flagged requiresConfirmation. */
  onConfirm?: (call: { name: string; arguments: Record<string, unknown> }) => Promise<ConfirmDecision>;
  signal?: AbortSignal;
}

export interface AgenticResult {
  text: string;
  turns: number;
  toolCalls: ToolResult[];
  requestId?: string;
  /** Full conversation incl. assistant/tool frames — for logging / datasets. */
  messages: Message[];
  /** Wall-clock duration of the whole agentic run, ms. */
  latencyMs: number;
}

export class Engine {
  private readonly provider: LLMProvider;
  private readonly registry: ToolRegistry;
  private readonly defaultSystem?: string;
  private readonly defaultMaxTurns: number;

  constructor(opts: EngineOptions) {
    this.provider = opts.provider;
    this.registry = opts.tools;
    this.defaultSystem = opts.defaultSystem;
    this.defaultMaxTurns = opts.defaultMaxTurns ?? 5;
  }

  async runAgentic(messages: Message[], opts: AgenticOptions = {}): Promise<AgenticResult> {
    const maxTurns = opts.maxTurns ?? this.defaultMaxTurns;
    const hasSystem = messages.some((m) => m.role === 'system');
    const system = hasSystem ? undefined : this.defaultSystem;

    const startedAt = Date.now();
    const history: Message[] = [...messages];
    const allTools = await this.registry.listTools();
    const executed: ToolResult[] = [];
    let lastRequestId: string | undefined;
    let finalText = '';
    let turns = 0;

    for (let turn = 1; turn <= maxTurns; turn++) {
      turns = turn;
      if (opts.signal?.aborted) break;

      const out = await this.provider.runTurn({
        messages: history,
        tools: allTools,
        system,
        onToken: opts.onToken ? (t) => opts.onToken!(t, turn) : undefined,
        signal: opts.signal,
      });

      lastRequestId = out.requestId;
      if (out.requestId) opts.onStart?.(out.requestId, turn);
      finalText = (out.text || '').trim();

      // No tool calls ⇒ the model produced its final answer.
      if (!out.toolCalls || out.toolCalls.length === 0) break;

      // Anchor the next turn with the raw assistant frame.
      history.push({ role: 'assistant', content: out.rawContent || finalText });

      for (const call of out.toolCalls) {
        opts.onToolCall?.({ name: call.name, arguments: call.arguments }, turn);
        const def = await this.registry.getDef(call.name);

        let result: unknown;
        if (def?.requiresConfirmation) {
          const decision = opts.onConfirm
            ? await opts.onConfirm({ name: call.name, arguments: call.arguments })
            : { approved: false, reason: 'no confirmation handler available' };
          if (decision.approved) {
            result = await this.safeExecute(call.name, call.arguments);
          } else {
            result = { declined: true, reason: decision.reason ?? 'user declined' };
          }
        } else {
          result = await this.safeExecute(call.name, call.arguments);
        }

        executed.push({ name: call.name, arguments: call.arguments, result });
        history.push({
          role: 'tool',
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }

      if (turn === maxTurns && !finalText) {
        finalText = 'I had to stop after several steps — please try a more specific request.';
      }
    }

    // Append the final answer so the returned conversation is complete (the
    // loop breaks before pushing the no-tool-call turn).
    if (finalText) history.push({ role: 'assistant', content: finalText });

    return {
      text: finalText,
      turns,
      toolCalls: executed,
      requestId: lastRequestId,
      messages: history,
      latencyMs: Date.now() - startedAt,
    };
  }

  async cancel(requestId: string): Promise<void> {
    await this.provider.cancel?.(requestId);
  }

  private async safeExecute(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.registry.execute(name, args);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}
