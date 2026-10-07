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

import type { ConfirmDecision, Message, ToolCall, ToolDef, ToolResult } from './types.js';
import type { InferenceMetrics, LLMProvider, ToolChoice } from './providers/types.js';
import type { ToolRegistry } from './tools/registry.js';
import { compressToolResult, type ToolCrushOptions } from './context/compress.js';
import {
  callKey,
  declinedToolResult,
  detectWalletAction,
  hasCapableTool,
  noToolReply,
  producedPaymentData,
  validateToolArgs,
} from './guards.js';
import { confirmReadback } from './wallet/confirm.js';
import { annotateRgbBalances } from './context/rgb-units.js';
import {
  REPEATED_CALL_REPLY,
  TOOL_CALL_FAILED_REPLY,
  cancelledReply,
  engine,
  finalizeAnswer,
  model,
  toolErrorFeedback,
  type Answer,
} from './engine/answer.js';
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

/** State of one agentic run. */
interface RunState {
  history: Message[];
  system?: string;
  tools: ToolDef[];
  executed: ToolResult[];
  inference: InferenceMetrics[];
  /** Calls made this run, by name + arguments, with their first result. */
  seen: Map<string, { result: unknown; count: number }>;
  lastRequestId?: string;
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
    const startedAt = Date.now();
    const maxTurns = opts.maxTurns ?? this.defaultMaxTurns;
    const registryTools = await this.registry.listTools();
    const state: RunState = {
      history: [...messages],
      system: messages.some((m) => m.role === 'system') ? undefined : this.defaultSystem,
      // Progressive disclosure: expose only the active skill's tools when set.
      tools: opts.allowedTools ? registryTools.filter((t) => opts.allowedTools!.includes(t.name)) : registryTools,
      executed: [],
      inference: [],
      seen: new Map(),
    };

    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const action = this.guardMissingTools ? detectWalletAction(lastUser) : null;
    if (action && !hasCapableTool(action, state.tools.map((t) => t.name))) {
      const text = noToolReply(action);
      state.history.push({ role: 'assistant', content: text });
      return { text, turns: 0, toolCalls: [], messages: state.history, latencyMs: Date.now() - startedAt, inference: state.inference };
    }

    let answer: Answer = model('');
    let turns = 0;
    let toolErrorRetries = 0;
    // A retry after an unreadable tool call does not count against maxTurns.
    for (let turn = 1; turn <= maxTurns + toolErrorRetries; turn++) {
      turns = turn;
      if (opts.signal?.aborted) break;

      // A forced first call only picks the tool and its arguments; reasoning
      // there costs most of the turn's time on small models.
      const forced = turn === 1 && opts.firstTurnToolChoice && state.tools.length;
      const out = await this.callModel(state, opts, turn, {
        tools: state.tools,
        ...(forced ? { toolChoice: opts.firstTurnToolChoice, ...(this.thinkOnForcedCalls ? {} : { thinking: 'off' as const }) } : {}),
      });
      if (out.requestId) opts.onStart?.(out.requestId, turn);
      answer = model(out.incomplete ? '' : (out.text || '').trim());

      if (!out.toolCalls?.length) {
        // The model tried to call a tool but the call didn't parse: tell it
        // what went wrong and let it try once more instead of showing the
        // broken frame as the answer.
        if (out.toolErrors?.length) {
          if (toolErrorRetries < 1) {
            toolErrorRetries += 1;
            state.history.push({ role: 'assistant', content: out.rawContent || answer.text });
            state.history.push({
              role: 'tool',
              content: JSON.stringify({ error: toolErrorFeedback(out.toolErrors, out.inference?.status === 'truncated') }),
            });
            continue;
          }
          answer = engine(TOOL_CALL_FAILED_REPLY);
          break;
        }
        // No tool calls ⇒ the model produced its final answer.
        if (!answer.text && state.executed.length) answer = await this.recoverAnswer(state, opts, turn);
        else if (!answer.text && out.incomplete) answer = model((out.text || '').trim());
        break;
      }

      // Anchor the next turn with the raw assistant frame.
      state.history.push({ role: 'assistant', content: out.rawContent || answer.text });

      let repeatedAgain = false;
      const declined: string[] = [];
      for (const call of out.toolCalls) {
        const step = await this.executeCall(state, call, opts, turn);
        repeatedAgain ||= step.repeatedAgain;
        if (step.declined) declined.push(step.declined);
      }

      if (this.endTurnOnDecline && declined.length && declined.length === out.toolCalls.length) {
        answer = engine(cancelledReply(declined));
        break;
      }

      if (repeatedAgain) {
        const last = await this.callModel(state, opts, turn, { tools: [] });
        const text = (last.text || '').trim();
        answer = text ? model(text) : engine(REPEATED_CALL_REPLY);
        break;
      }
    }

    const text = finalizeAnswer(answer, {
      fixAmounts: this.fixAmounts,
      guardPaymentData: this.guardPaymentData,
      sources: [...messages.map((m) => m.content), ...state.executed.map((e) => e.result)],
      toolResults: state.executed.map((e) => e.result),
      produced: producedPaymentData(state.executed),
      aborted: !!opts.signal?.aborted,
    });
    // Append the final answer so the returned conversation is complete (the
    // loop breaks before pushing the no-tool-call turn).
    if (text) state.history.push({ role: 'assistant', content: text });

    return {
      text,
      turns,
      toolCalls: state.executed,
      requestId: state.lastRequestId,
      messages: state.history,
      latencyMs: Date.now() - startedAt,
      inference: state.inference,
    };
  }

  /** One model call within the run's session; records its receipt. */
  private async callModel(
    state: RunState,
    opts: AgenticOptions,
    turn: number,
    extra: { tools: ToolDef[]; messages?: Message[]; toolChoice?: ToolChoice; thinking?: 'off' },
  ) {
    const out = await this.provider.runTurn({
      messages: extra.messages ?? state.history,
      system: state.system,
      sessionKey: opts.sessionKey,
      ...extra,
      onToken: opts.onToken ? (t) => opts.onToken!(t, turn) : undefined,
      signal: opts.signal,
    });
    if (out.inference) state.inference.push(out.inference);
    if (out.requestId) state.lastRequestId = out.requestId;
    return out;
  }

  /**
   * Validate, confirm (for spends) and execute one tool call, and add its
   * result to the history. Returns the readback when the user declined it.
   */
  private async executeCall(
    state: RunState,
    call: ToolCall,
    opts: AgenticOptions,
    turn: number,
  ): Promise<{ repeatedAgain: boolean; declined?: string }> {
    opts.onToolCall?.({ name: call.name, arguments: call.arguments }, turn);
    const def = await this.registry.getDef(call.name);
    const key = callKey(call.name, call.arguments);
    const previous = state.seen.get(key);
    let repeatedAgain = false;
    let declined: string | undefined;

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
          declined = summary ? summary.replace(/\.?\s*Confirm\?$/, '') : call.name.replace(/_/g, ' ');
        }
      } else {
        args = check.args;
        result = await this.safeExecute(call.name, args);
      }
    }

    if (!previous) {
      // A mutating (confirm-gated) call can change what reads return.
      if (def?.requiresConfirmation) state.seen.clear();
      state.seen.set(key, { result, count: 1 });
    }
    state.executed.push({ name: call.name, arguments: args, result });
    opts.onToolResult?.({ name: call.name, arguments: args, result }, turn);
    state.history.push({ role: 'tool', content: this.toHistoryContent(this.fixAmounts ? annotateRgbBalances(result) : result) });
    return { repeatedAgain, ...(declined ? { declined } : {}) };
  }

  /**
   * The model ran tools but produced no visible answer (e.g. reasoning used the
   * whole output budget). Ask once more without tools; if that is empty too,
   * show the last tool result instead of an empty reply.
   */
  private async recoverAnswer(state: RunState, opts: AgenticOptions, turn: number): Promise<Answer> {
    if (opts.signal?.aborted) return model('');
    const retry = await this.callModel(state, opts, turn, {
      tools: [],
      messages: [
        ...state.history,
        { role: 'user', content: 'Answer my question now from the tool results above, in a few short sentences.' },
      ],
    });
    const text = retry.incomplete ? '' : (retry.text || '').trim();
    if (text) return model(text);
    const last = state.executed[state.executed.length - 1]!;
    const body = compressToolResult(last.result, this.compressOpts ?? {}).content;
    return engine(
      `I couldn't phrase an answer in time. Here is what ${last.name.replace(/_/g, ' ')} returned:\n\n${body.length > 2000 ? `${body.slice(0, 2000)}…` : body}`,
    );
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
