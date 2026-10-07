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
 * inference runs on a remote server.
 */

import type { ConfirmDecision, Message, ToolResult } from './types.js';
import type { LLMProvider } from './providers/types.js';
import type { InferenceMetrics, ToolCallError, ToolChoice } from './providers/types.js';
import type { ToolRegistry } from './tools/registry.js';
import { compressToolResult, type ToolCrushOptions } from './context/compress.js';
import {
  callKey,
  declinedToolResult,
  detectWalletAction,
  hasCapableTool,
  noToolReply,
  findUngroundedPaymentData,
  fixSatsBtcConversions,
  ungroundedReply,
  validateToolArgs,
} from './guards.js';
import { confirmReadback } from './wallet/confirm.js';
import { annotateRgbBalances, fixRgbBalanceUnits } from './context/rgb-units.js';
import type { SkillRegistry } from './skills/registry.js';
import type { Skill } from './skills/types.js';
import { selectAvailableSkill } from './skills/select.js';

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
  /** Let the model reason on a forced first tool call. Default false (thinking off). */
  thinkOnForcedCalls?: boolean;
  /**
   * Answer a wallet action (create an invoice, get an address, pay, send) with
   * a fixed "no tool" reply, without inference, when no exposed tool can do it.
   * Default true.
   */
  guardMissingTools?: boolean;
  /** End the run with a fixed "Cancelled" reply when the user declines every call in a turn. Default true. */
  endTurnOnDecline?: boolean;
}

export interface ComposedSkill {
  skill: Skill | null;
  system: string;
  allowedTools?: string[];
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
  /** Session key passed to every model call of this run. Default: a fresh key per run. */
  sessionKey?: string;
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
  private readonly thinkOnForcedCalls: boolean;
  private readonly guardMissingTools: boolean;
  private readonly endTurnOnDecline: boolean;

  constructor(opts: EngineOptions) {
    this.provider = opts.provider;
    this.registry = opts.tools;
    this.defaultSystem = opts.defaultSystem;
    this.defaultMaxTurns = opts.defaultMaxTurns ?? 5;
    this.guardPaymentData = opts.guardUngroundedPaymentData ?? true;
    this.fixAmounts = opts.fixAmountConversions ?? true;
    this.thinkOnForcedCalls = opts.thinkOnForcedCalls ?? false;
    this.guardMissingTools = opts.guardMissingTools ?? true;
    this.endTurnOnDecline = opts.endTurnOnDecline ?? true;
    this.compressOpts = opts.compressToolOutput
      ? opts.compressToolOutput === true
        ? {}
        : opts.compressToolOutput
      : undefined;
  }

  /**
   * Select the skill for `query` among those that can act with this engine's
   * tools (skills whose `requires-tools` are missing are skipped), then
   * compose its system prompt. Pass the result to runAgentic:
   *
   *   const { system, allowedTools } = await engine.composeSkill(skills, question, base);
   *   await engine.runAgentic([{ role: 'system', content: system }, { role: 'user', content: question }], { allowedTools });
   */
  async composeSkill(skills: SkillRegistry, query: string, base: string): Promise<ComposedSkill> {
    const skill = selectAvailableSkill(skills, query, await this.registry.listTools());
    return { skill, ...skills.compose(base, skill) };
  }

  async runAgentic(messages: Message[], opts: AgenticOptions = {}): Promise<AgenticResult> {
    const sessionKey = opts.sessionKey ?? `mind-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      return await this.runAgenticSession(messages, { ...opts, sessionKey });
    } finally {
      if (!opts.sessionKey) await this.provider.endSession?.(sessionKey).catch(() => {});
    }
  }

  private async runAgenticSession(messages: Message[], opts: AgenticOptions): Promise<AgenticResult> {
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
    // Set when finalText is one of the engine's own fixed replies, which the
    // answer guards below must not rewrite.
    let engineReply = false;
    let turns = 0;
    const inference: InferenceMetrics[] = [];
    const seen = new Map<string, { result: unknown; count: number }>();
    let toolErrorRetries = 0;

    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const action = this.guardMissingTools ? detectWalletAction(lastUser) : null;
    if (action && !hasCapableTool(action, allTools.map((t) => t.name))) {
      const text = noToolReply(action);
      history.push({ role: 'assistant', content: text });
      return { text, turns: 0, toolCalls: [], messages: history, latencyMs: Date.now() - startedAt, inference };
    }

    // A retry after an unreadable tool call does not count against maxTurns.
    for (let turn = 1; turn <= maxTurns + toolErrorRetries; turn++) {
      turns = turn;
      if (opts.signal?.aborted) break;

      const out = await this.provider.runTurn({
      sessionKey: opts.sessionKey,
        messages: history,
        tools: allTools,
        system,
        // A forced first call only picks the tool and its arguments; reasoning
        // there costs most of the turn's time on small models.
        ...(turn === 1 && opts.firstTurnToolChoice && allTools.length
          ? { toolChoice: opts.firstTurnToolChoice, ...(this.thinkOnForcedCalls ? {} : { thinking: 'off' as const }) }
          : {}),
        onToken: opts.onToken ? (t) => opts.onToken!(t, turn) : undefined,
        signal: opts.signal,
      });

      lastRequestId = out.requestId;
      if (out.inference) inference.push(out.inference);
      if (out.requestId) opts.onStart?.(out.requestId, turn);
      finalText = out.incomplete ? '' : (out.text || '').trim();

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
        engineReply = true;
        break;
      }

      // No tool calls ⇒ the model produced its final answer.
      if (!out.toolCalls || out.toolCalls.length === 0) {
        if (!finalText && executed.length) finalText = await this.recoverAnswer(history, system, executed, inference, opts, turn);
        else if (!finalText && out.incomplete) finalText = (out.text || '').trim();
        break;
      }

      // Anchor the next turn with the raw assistant frame.
      history.push({ role: 'assistant', content: out.rawContent || finalText });

      let repeatedAgain = false;
      const declinedThisTurn: string[] = [];
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
            if (decision.approved) {
              result = await this.safeExecute(call.name, args);
            } else {
              result = declinedToolResult(call.name, decision.reason);
              declinedThisTurn.push(summary ? summary.replace(/\.?\s*Confirm\?$/, '') : call.name.replace(/_/g, ' '));
            }
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

      if (this.endTurnOnDecline && declinedThisTurn.length && declinedThisTurn.length === out.toolCalls.length) {
        finalText = `Cancelled — you declined: ${declinedThisTurn.join('; ')}. Nothing was sent or changed.`;
        engineReply = true;
        break;
      }

      if (repeatedAgain) {
        const forced = await this.provider.runTurn({
      sessionKey: opts.sessionKey,
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
    if (!finalText && !opts.signal?.aborted) {
      finalText = STOPPED_MESSAGE;
      engineReply = true;
    }

    if (this.fixAmounts && finalText && !engineReply) {
      finalText = fixRgbBalanceUnits(fixSatsBtcConversions(finalText), executed.map((e) => e.result));
    }

    if (this.guardPaymentData && finalText && !engineReply) {
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

  /**
   * The model ran tools but produced no visible answer (e.g. reasoning used the
   * whole output budget). Ask once more without tools; if that is empty too,
   * show the last tool result instead of an empty reply.
   */
  private async recoverAnswer(
    history: Message[],
    system: string | undefined,
    executed: ToolResult[],
    inference: InferenceMetrics[],
    opts: AgenticOptions,
    turn: number,
  ): Promise<string> {
    if (opts.signal?.aborted) return '';
    const retry = await this.provider.runTurn({
      sessionKey: opts.sessionKey,
      messages: [
        ...history,
        { role: 'user', content: 'Answer my question now from the tool results above, in a few short sentences.' },
      ],
      tools: [],
      system,
      onToken: opts.onToken ? (t) => opts.onToken!(t, turn) : undefined,
      signal: opts.signal,
    });
    if (retry.inference) inference.push(retry.inference);
    const text = retry.incomplete ? '' : (retry.text || '').trim();
    if (text) return text;
    const last = executed[executed.length - 1]!;
    const body = compressToolResult(last.result, this.compressOpts ?? {}).content;
    return `I couldn't phrase an answer in time. Here is what ${last.name.replace(/_/g, ' ')} returned:\n\n${body.length > 2000 ? `${body.slice(0, 2000)}…` : body}`;
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
