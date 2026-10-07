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
 * The host owns model lifecycle (load/unload, local-vs-delegated) and passes
 * `getModelId()` so a turn always runs against the currently-loaded model.
 * Tools are forwarded by schema only; the Engine executes them via its
 * ToolSources, so signing/spending stays on the host even when inference is
 * delegated to a desktop peer.
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
   * answers. If the stream still runs well past it, the run is cancelled and a
   * short fallback is returned instead of hanging on "Thinking…". Omit for
   * unlimited reasoning.
   */
  maxThinkingTokens?: number;
  /**
   * Keep each agentic run in a QVAC KV-cache session (`kvCache: sessionKey`),
   * so calls after the first send only the new message instead of re-reading
   * the whole prompt. Needs `deleteCache` to drop the session at the end.
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

/** Shown when a turn is cut off because it blew its thinking-token budget. */
const THINKING_BUDGET_FALLBACK =
  'I spent my whole thinking budget on that one without landing an answer. ' +
  'Try asking again, more specifically.';

export function createQvacProvider(options: QvacProviderOptions): LLMProvider {
  return {
    name: 'qvac',

    async runTurn(input: QvacTurnInput): Promise<TurnOutput> {
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
        // Backstop only: the SDK enforces the budget itself, and our count is a
        // char-based estimate, so leave headroom before cancelling.
        maxThinkingTokens:
          maxThinkingTokens === undefined ? undefined : Math.ceil(maxThinkingTokens * 1.25) + 32,
        // Cancel the in-flight run the moment the thinking budget is blown — the
        // SDK keeps generating otherwise. Fire-and-forget; `final` then resolves.
        onThinkingBudgetExceeded: () => {
          void options.cancel({ requestId: run.requestId }).catch(() => {});
        },
      });

      // Surface the real per-turn inference stats (backend device + throughput).
      if (result.stats) (input.onStats ?? options.onStats)?.(result.stats);

      // A turn cut off mid-reasoning has no visible answer — return a short note
      // instead of an empty bubble so the agentic loop ends cleanly.
      const text =
        result.text || (result.thinkingBudgetExceeded ? THINKING_BUDGET_FALLBACK : result.text);
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
        !result.text && result.toolCalls.length === 0 && (result.thinkingBudgetExceeded || !!result.truncated);
      return {
        text,
        rawContent: result.rawContent,
        toolCalls: result.toolCalls,
        ...(result.toolErrors ? { toolErrors: result.toolErrors } : {}),
        requestId: result.requestId,
        inference,
        ...(incomplete ? { incomplete: true } : {}),
      };
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
