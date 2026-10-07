/**
 * createQvacProvider — turns `@qvac/sdk` `completion()` into the shared
 * `@kaleidorg/mind` `LLMProvider` the Engine/Funnel consumes. This is the one
 * place the SDK is called for inference; every host (rate, desktop provider,
 * cli) uses it instead of hand-rolling its own completion wrapper.
 *
 * The SDK functions are *injected*, not imported, so this package carries no
 * runtime dependency on `@qvac/sdk` (the import below is type-only and erased).
 * Hosts pass their own `completion`/`cancel` — rate the static RN import, the
 * desktop sidecar its lazily-loaded SDK facade — which also makes this provider
 * unit-testable with a fake completion.
 *
 * The host owns model lifecycle (load/unload) and passes
 * `getModelId()` so a turn always runs against the currently-loaded model.
 * Tools are forwarded by schema only; the Engine executes them via its
 * ToolSources, so signing and spending stay on the host.
 */
import type * as QvacSdk from '@qvac/sdk';
import type { InferenceMetrics, LLMProvider, TurnInput, TurnOutput } from '../providers/types.js';
import type { QvacTurnStats } from './parse.js';
import { consumeRun } from './stream.js';
import { toQvacTools } from './tools.js';

type CompletionFn = typeof QvacSdk.completion;
type CancelFn = typeof QvacSdk.cancel;
type DeleteCacheFn = typeof QvacSdk.deleteCache;

export interface QvacProviderOptions {
  /** The SDK's `completion` (injected — see module docs). */
  completion: CompletionFn;
  /** The SDK's `cancel` (injected). */
  cancel: CancelFn;
  /** Resolve the loaded model id for this turn (null ⇒ not loaded → throws). */
  getModelId: () => string | null;
  /**
   * Default sampling temperature. Omit to leave it to the SDK/model default —
   * `generationParams` is only sent when a temperature or max-tokens is set, so
   * a host that passes neither preserves the SDK's own defaults.
   */
  defaultTemperature?: number;
  /** Default max output tokens — caps a turn so it can't ramble. Omit for uncapped. */
  defaultMaxTokens?: number;
  /**
   * Cap `<think>` reasoning at this many TOKENS (not seconds — tok/s varies).
   * Sent as the SDK's `reasoning_budget`, so the model closes its reasoning and
   * answers. Kept below the output cap. Omit for unlimited reasoning.
   */
  maxThinkingTokens?: number;
  /**
   * Experimental. Keep each agentic run in a QVAC KV-cache session
   * (`kvCache: sessionKey`), so calls after the first send only the new
   * message instead of re-reading the whole prompt. Needs `deleteCache` to
   * drop the session at the end. In the rgb-agent eval (Qwen3.5 2B) it cut
   * time to first token from ~7 s to ~0.2 s, but the model copied a Lightning
   * invoice correctly in 4/10 runs with it vs 10/10 without. Off by default.
   */
  sessionCache?: boolean;
  /** The SDK's `deleteCache` (injected); used with `sessionCache`. */
  deleteCache?: DeleteCacheFn;
  /** Stream the model's `<think>` reasoning, when a host wants to surface it. */
  onThinking?: (token: string) => void;
  /**
   * Per-turn inference stats (real backend device + throughput), when a host
   * wants to surface them. Fires once per turn after the `final` frame resolves.
   */
  onStats?: (stats: QvacTurnStats) => void;
}

/** TurnInput plus the per-call knobs the funnel/voice paths pass through. */
export interface QvacTurnInput extends TurnInput {
  temperature?: number;
  maxTokens?: number;
  /** Per-turn override of the thinking-token cap (see QvacProviderOptions). */
  maxThinkingTokens?: number;
  onThinking?: (token: string) => void;
  onStats?: (stats: QvacTurnStats) => void;
}

/**
 * llama.cpp's tool-call grammar can reject the `</think>` it inserts when a
 * reasoning budget runs out ("Unexpected empty grammar stack after accepting
 * piece: </think>"), which aborts the turn.
 */
function isReasoningGrammarError(err: unknown): boolean {
  return /empty grammar stack/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * Some chat templates (e.g. Llama 3.2 tool-calling 1B) don't render the tool
 * definitions the way a forced `tool_choice` needs ("tool_choice demanded a
 * tool call, but the chat template did not render the tool definitions").
 */
function isToolChoiceTemplateError(err: unknown): boolean {
  return /did not render the tool definitions/i.test(err instanceof Error ? err.message : String(err));
}

export function createQvacProvider(options: QvacProviderOptions): LLMProvider {
  const runTurnOnce = async (input: QvacTurnInput): Promise<TurnOutput> => {
      const modelId = options.getModelId();
      if (!modelId) throw new Error('QVAC model not loaded');

      const history = input.system
        ? [{ role: 'system', content: input.system }, ...input.messages]
        : input.messages;

      // Tools are forwarded by schema only — the Engine validates + executes.
      // JSON-Schema tools are normalised to the SDK's Tool shape (see tools.ts).
      const tools = toQvacTools(input.tools);

      // QVAC (0.13+) nests sampling under `generationParams`; top-level
      // `temperature`/`max_tokens` (as older rate code passed) are dropped by
      // validation, so the cap silently no-op'd. Build it here, and only send it
      // when a value is set so a host that passes neither keeps SDK defaults.
      const temp = input.temperature ?? options.defaultTemperature;
      const predict = input.maxTokens ?? options.defaultMaxTokens;
      // A thinking budget at or above the output cap never binds: the model can
      // spend the whole turn reasoning and return no answer. Keep half for it.
      const thinkingCap = input.thinking === 'off' ? 0 : (input.maxThinkingTokens ?? options.maxThinkingTokens);
      const maxThinkingTokens =
        thinkingCap !== undefined && predict !== undefined && thinkingCap >= predict
          ? Math.floor(predict / 2)
          : thinkingCap;
      // `tool_choice` is only meaningful with tools; the SDK rejects a named
      // choice that isn't among them.
      const toolChoice = tools && input.toolChoice ? input.toolChoice : undefined;
      const generationParamsRaw = {
        ...(temp !== undefined ? { temp } : {}),
        ...(predict !== undefined ? { predict } : {}),
        ...(maxThinkingTokens !== undefined ? { reasoning_budget: maxThinkingTokens } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
      };
      const generationParams = Object.keys(generationParamsRaw).length ? generationParamsRaw : undefined;

      const run = options.completion({
        modelId,
        history,
        stream: true,
        // Split `<think>` into separate thinkingDelta events so reasoning never
        // pollutes the visible answer.
        captureThinking: true,
        ...(options.sessionCache && input.sessionKey ? { kvCache: input.sessionKey } : {}),
        ...(generationParams ? { generationParams } : {}),
        ...(tools ? { tools } : {}),
      } as unknown as Parameters<CompletionFn>[0]);

      // Honor an external AbortSignal (e.g. the desktop "stop" button): cancel
      // the in-flight run the moment it fires. The SDK keeps generating
      // otherwise; `final` then resolves with stopReason 'cancelled'. This is
      // the single place that makes signal-based cancellation work for EVERY
      // caller (agentic loop + recipe slot extraction).
      if (input.signal) {
        if (input.signal.aborted) {
          void options.cancel({ requestId: run.requestId }).catch(() => {});
        } else {
          input.signal.addEventListener(
            'abort',
            () => void options.cancel({ requestId: run.requestId }).catch(() => {}),
            { once: true },
          );
        }
      }

      const result = await consumeRun(run, {
        onToken: input.onToken,
        onThinking: input.onThinking ?? options.onThinking,
      });

      // Surface the real per-turn inference stats (backend device + throughput).
      if (result.stats) (input.onStats ?? options.onStats)?.(result.stats);

      const text = result.text;
      const promptTokens = result.stats?.promptTokens;
      const generated = result.stats?.generatedTokens;
      const totalTokens =
        result.stats?.totalTokens ??
        (typeof generated === 'number' && typeof promptTokens === 'number' ? promptTokens + generated : undefined);
      const inference: InferenceMetrics = {
        requestId: result.requestId,
        durationMs: result.timing.durationMs,
        status:
          result.stopReason === 'cancelled'
            ? 'cancelled'
            : result.truncated
              ? 'truncated'
              : 'completed',
        ...(result.stats?.backendDevice ? { backendDevice: result.stats.backendDevice } : {}),
        ...(typeof promptTokens === 'number' ? { promptTokens } : {}),
        ...(typeof totalTokens === 'number' ? { totalTokens } : {}),
        ...(typeof totalTokens === 'number' && typeof promptTokens === 'number'
          ? { completionTokens: Math.max(0, totalTokens - promptTokens) }
          : {}),
        ...(typeof result.timing.ttftMs === 'number' ? { ttftMs: result.timing.ttftMs } : {}),
        ...(typeof result.stats?.tokensPerSecond === 'number'
          ? { tokensPerSecond: result.stats.tokensPerSecond }
          : {}),
        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
      };

      const incomplete =
        !result.text && result.toolCalls.length === 0 && !!result.truncated;
      return {
        text,
        rawContent: result.rawContent,
        toolCalls: result.toolCalls,
        ...(result.toolErrors ? { toolErrors: result.toolErrors } : {}),
        requestId: result.requestId,
        inference,
        ...(incomplete ? { incomplete: true } : {}),
      };
  };

  return {
    name: 'qvac',

    async runTurn(input: QvacTurnInput): Promise<TurnOutput> {
      try {
        return await runTurnOnce(input);
      } catch (err) {
        // Retry once without reasoning: no budget, so nothing to insert.
        if (input.thinking !== 'off' && isReasoningGrammarError(err)) return runTurnOnce({ ...input, thinking: 'off' });
        // Retry once without forcing a tool call; the model may still call one.
        if (input.toolChoice && isToolChoiceTemplateError(err)) {
          const { toolChoice: _forced, ...rest } = input;
          return runTurnOnce(rest);
        }
        throw err;
      }
    },

    async endSession(sessionKey: string): Promise<void> {
      if (!options.sessionCache || !options.deleteCache) return;
      try {
        await options.deleteCache({ kvCacheKey: sessionKey });
      } catch (err) {
        console.warn('[qvac] deleteCache failed:', err);
      }
    },

    async cancel(requestId: string): Promise<void> {
      // The cancel only lands once the server has begun the request; a same-tick
      // cancel may race the begin and is logged as a no-match by the SDK.
      try {
        await options.cancel({ requestId });
      } catch (err) {
        console.warn('[qvac] cancel failed:', err);
      }
    },
  };
}
