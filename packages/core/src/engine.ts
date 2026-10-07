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
import type { InferenceMetrics, ToolCallError, ToolChoice } from './providers/types.js';
import type { ToolRegistry } from './tools/registry.js';
import { compressToolResult, type ToolCrushOptions } from './context/compress.js';
import {
  DECLINED_TOOL_MESSAGE,
  callKey,
  findUngroundedPaymentData,
  fixSatsBtcConversions,
  ungroundedReply,
  validateToolArgs,
} from './guards.js';
import { confirmReadback } from './wallet/confirm.js';
import { annotateRgbBalances, fixRgbBalanceUnits } from './context/rgb-units.js';

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
  /**
   * Replace a final answer that contains an invoice/address/payment request no
   * tool returned and the user never typed. Default true.
   */
  guardUngroundedPaymentData?: boolean;
  /**
   * Keep amounts honest: recompute BTC figures paired with a sats amount, add
   * `balance_display` to RGB asset balances the model sees, and relabel an
   * asset balance the answer calls sats. Default true.
   */
  fixAmountConversions?: boolean;
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
  onConfirm?: (call: { name: string; arguments: Record<string, unknown>; summary?: string }) => Promise<ConfirmDecision>;
  /**
   * Restrict the tools exposed to the model this run (progressive disclosure).
   * Typically the active skill's tool list — see SkillRegistry.compose().
   */
  allowedTools?: string[];
  /**
   * Tool choice for the FIRST model call only — e.g. `'required'` when the
   * request is a wallet action, so the model can't answer in prose with
   * made-up data. Later rounds are left to the model.
   */
  firstTurnToolChoice?: ToolChoice;
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

const STOPPED_MESSAGE = 'I had to stop after several steps — please try a more specific request.';

const TOOL_CALL_FAILED_MESSAGE =
  "I couldn't put together a valid request for that. Please rephrase it with the exact values (asset, amount, recipient).";

function toolErrorMessage(errors: ToolCallError[], cutOff: boolean): string {
  if (cutOff) {
    return 'Your tool call was cut off because the output got too long. Make ONE tool call at a time with only the required arguments, or answer from the results you already have.';
  }
  const detail = errors.map((e) => e.message).join('; ');
  return `Your tool call could not be read (${detail}). Call the tool again with valid JSON arguments that match its schema, or ask the user for the missing values.`;
}

export class Engine {
  private readonly provider: LLMProvider;
  private readonly registry: ToolRegistry;
  private readonly defaultSystem?: string;
  private readonly defaultMaxTurns: number;
  private readonly compressOpts?: ToolCrushOptions;
  private readonly guardPaymentData: boolean;
  private readonly fixAmounts: boolean;

  constructor(opts: EngineOptions) {
    this.provider = opts.provider;
    this.registry = opts.tools;
    this.defaultSystem = opts.defaultSystem;
    this.defaultMaxTurns = opts.defaultMaxTurns ?? 5;
    this.guardPaymentData = opts.guardUngroundedPaymentData ?? true;
    this.fixAmounts = opts.fixAmountConversions ?? true;
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
    const seen = new Map<string, { result: unknown; count: number }>();
    let toolErrorRetries = 0;

    // A retry after an unreadable tool call does not count against maxTurns.
    for (let turn = 1; turn <= maxTurns + toolErrorRetries; turn++) {
      turns = turn;
      if (opts.signal?.aborted) break;

      const out = await this.provider.runTurn({
        messages: history,
        tools: allTools,
        system,
        ...(turn === 1 && opts.firstTurnToolChoice && allTools.length
          ? { toolChoice: opts.firstTurnToolChoice }
          : {}),
        onToken: opts.onToken ? (t) => opts.onToken!(t, turn) : undefined,
        signal: opts.signal,
      });

      lastRequestId = out.requestId;
      if (out.inference) inference.push(out.inference);
      if (out.requestId) opts.onStart?.(out.requestId, turn);
      finalText = (out.text || '').trim();

      // The model tried to call a tool but the call didn't parse: tell it what
      // went wrong and let it try again (once) instead of showing the broken
      // frame as the answer.
      if ((!out.toolCalls || out.toolCalls.length === 0) && out.toolErrors?.length) {
        if (toolErrorRetries < 1) {
          toolErrorRetries += 1;
          const cutOff = out.inference?.status === 'truncated';
          history.push({ role: 'assistant', content: out.rawContent || finalText });
          history.push({ role: 'tool', content: JSON.stringify({ error: toolErrorMessage(out.toolErrors, cutOff) }) });
          continue;
        }
        finalText = TOOL_CALL_FAILED_MESSAGE;
        break;
      }

      // No tool calls ⇒ the model produced its final answer.
      if (!out.toolCalls || out.toolCalls.length === 0) break;

      // Anchor the next turn with the raw assistant frame.
      history.push({ role: 'assistant', content: out.rawContent || finalText });

      let repeatedAgain = false;
      for (const call of out.toolCalls) {
        opts.onToolCall?.({ name: call.name, arguments: call.arguments }, turn);
        const def = await this.registry.getDef(call.name);
        const key = callKey(call.name, call.arguments);
        const previous = seen.get(key);

        let args = call.arguments;
        let result: unknown;
        if (previous) {
          previous.count += 1;
          if (previous.count > 2) repeatedAgain = true;
          result = {
            error:
              `You already called ${call.name} with these arguments; the result was: ` +
              `${this.toHistoryContent(previous.result)}. Do not call it again — answer the user now.`,
          };
        } else if (!def) {
          result = { error: `Unknown tool "${call.name}".` };
        } else {
          const check = validateToolArgs(def, call.arguments);
          if (!check.ok) {
            result = {
              error: `Invalid arguments for ${call.name}: ${check.errors.join('; ')}. Fix them or ask the user for the missing values.`,
            };
          } else if (def.requiresConfirmation) {
            args = check.args;
            const summary = confirmReadback({ name: call.name, arguments: args }) ?? undefined;
            const decision = opts.onConfirm
              ? await opts.onConfirm({ name: call.name, arguments: args, ...(summary ? { summary } : {}) })
              : { approved: false, reason: 'no confirmation handler available' };
            result = decision.approved
              ? await this.safeExecute(call.name, args)
              : { declined: true, message: DECLINED_TOOL_MESSAGE, ...(decision.reason ? { reason: decision.reason } : {}) };
          } else {
            args = check.args;
            result = await this.safeExecute(call.name, args);
          }
        }

        if (!previous) {
          // A mutating (confirm-gated) call can change what reads return.
          if (def?.requiresConfirmation) seen.clear();
          seen.set(key, { result, count: 1 });
        }
        executed.push({ name: call.name, arguments: args, result });
        opts.onToolResult?.({ name: call.name, arguments: args, result }, turn);
        history.push({ role: 'tool', content: this.toHistoryContent(this.fixAmounts ? annotateRgbBalances(result) : result) });
      }

      if (repeatedAgain) {
        const forced = await this.provider.runTurn({
          messages: history,
          tools: [],
          system,
          onToken: opts.onToken ? (t) => opts.onToken!(t, turn) : undefined,
          signal: opts.signal,
        });
        if (forced.inference) inference.push(forced.inference);
        finalText = (forced.text || '').trim() || 'I could not get a different result from the wallet — please try a more specific request.';
        break;
      }

    }

    // Never return an empty answer (e.g. the last turn ran out of tokens).
    if (!finalText && !opts.signal?.aborted) finalText = STOPPED_MESSAGE;

    if (this.fixAmounts && finalText) {
      finalText = fixRgbBalanceUnits(fixSatsBtcConversions(finalText), executed.map((e) => e.result));
    }

    if (this.guardPaymentData && finalText) {
      const ungrounded = findUngroundedPaymentData(finalText, [
        ...messages.map((m) => m.content),
        ...executed.map((e) => e.result),
      ]);
      if (ungrounded.length) finalText = ungroundedReply(ungrounded);
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
