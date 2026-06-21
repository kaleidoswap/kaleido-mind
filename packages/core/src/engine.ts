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
import type { InferenceMetrics } from './providers/types.js';
import type { ToolRegistry } from './tools/registry.js';
import { compressToolResult, type ToolCrushOptions } from './context/compress.js';

export interface EngineOptions {
  provider: LLMProvider;
  tools: ToolRegistry;
  /** Prepended as a system message when the caller didn't supply one. */
  defaultSystem?: string;
  /** Max reasoning↔tool rounds before forcing a stop. Default 5. */
  defaultMaxTurns?: number;
  /**
   * Crush verbose tool results before they're fed back into history, so a
   * tiny on-device model's context window isn't drowned in repetitive JSON
   * (merchant lists, tx history, nested quotes). `true` uses safe defaults;
   * pass options to tune. Off by default — small results are never touched and
   * amounts/addresses/invoices are always preserved (see compressToolResult).
   * The `onToolResult` callback and `toolCalls` still carry the raw result.
   */
  compressToolOutput?: boolean | ToolCrushOptions;
}

export interface AgenticOptions {
  maxTurns?: number;
  /** Visible content tokens as they stream, tagged with the current turn. */
  onToken?: (token: string, turn: number) => void;
  /** The live requestId for the current turn (so a stop button can cancel it). */
  onStart?: (requestId: string, turn: number) => void;
  /** Fired when the model requests a tool, before it executes. */
  onToolCall?: (call: { name: string; arguments: Record<string, unknown> }, turn: number) => void;
  /**
   * Fired after a tool returns (success OR error — errors arrive as `{error}`).
   * Useful for surfacing the raw response back to the user in a debug UI.
   */
  onToolResult?: (event: { name: string; arguments: Record<string, unknown>; result: unknown }, turn: number) => void;
  /** Human-in-the-loop gate for tools flagged requiresConfirmation. */
  onConfirm?: (call: { name: string; arguments: Record<string, unknown> }) => Promise<ConfirmDecision>;
  /**
   * Restrict the tools exposed to the model this run (progressive disclosure).
   * Typically the active skill's tool list — see SkillRegistry.compose().
   */
  allowedTools?: string[];
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
  /** One receipt per model call in this agentic run. */
  inference: InferenceMetrics[];
}

export class Engine {
  private readonly provider: LLMProvider;
  private readonly registry: ToolRegistry;
  private readonly defaultSystem?: string;
  private readonly defaultMaxTurns: number;
  private readonly compressOpts?: ToolCrushOptions;

  constructor(opts: EngineOptions) {
    this.provider = opts.provider;
    this.registry = opts.tools;
    this.defaultSystem = opts.defaultSystem;
    this.defaultMaxTurns = opts.defaultMaxTurns ?? 5;
    this.compressOpts = opts.compressToolOutput
      ? opts.compressToolOutput === true
        ? {}
        : opts.compressToolOutput
      : undefined;
  }

  async runAgentic(messages: Message[], opts: AgenticOptions = {}): Promise<AgenticResult> {
    const maxTurns = opts.maxTurns ?? this.defaultMaxTurns;
    const hasSystem = messages.some((m) => m.role === 'system');
    const system = hasSystem ? undefined : this.defaultSystem;

    const startedAt = Date.now();
    const history: Message[] = [...messages];
    const registryTools = await this.registry.listTools();
    // Progressive disclosure: expose only the active skill's tools when set.
    const allTools = opts.allowedTools
      ? registryTools.filter((t) => opts.allowedTools!.includes(t.name))
      : registryTools;
    const executed: ToolResult[] = [];
    let lastRequestId: string | undefined;
    let finalText = '';
    let turns = 0;
    const inference: InferenceMetrics[] = [];

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
      if (out.inference) inference.push(out.inference);
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
        opts.onToolResult?.({ name: call.name, arguments: call.arguments, result }, turn);
        history.push({ role: 'tool', content: this.toHistoryContent(result) });
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
      inference,
    };
  }

  async cancel(requestId: string): Promise<void> {
    await this.provider.cancel?.(requestId);
  }

  /**
   * Serialize a tool result for history, optionally crushing verbose JSON so
   * it doesn't swamp a small context window. The raw result is unchanged for
   * callbacks/logs — only the model-facing history copy is compressed.
   */
  private toHistoryContent(result: unknown): string {
    if (!this.compressOpts) {
      return typeof result === 'string' ? result : JSON.stringify(result);
    }
    return compressToolResult(result, this.compressOpts).content;
  }

  private async safeExecute(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.registry.execute(name, args);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}
