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

type CompletionFn = typeof QvacSdk.completion;
type CancelFn = typeof QvacSdk.cancel;

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
   * Cap `<think>` reasoning at this many TOKENS (not seconds — tok/s varies, and
   * the SDK has no numeric reasoning budget). When a turn's thinking exceeds it,
   * the run is cancelled and a short fallback is returned instead of hanging on
   * "Thinking…". Omit for unlimited reasoning.
   */
  maxThinkingTokens?: number;
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

      // Tools are forwarded by schema only (name/description/parameters). We
      // carry `parameters` through verbatim (Zod for in-process tools, JSON
      // Schema for MCP) — the model only needs the shape to pick a call; the
      // Engine validates + executes.
      const tools = input.tools.length
        ? input.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          }))
        : undefined;

      // QVAC 0.13 nests sampling under `generationParams`; top-level
      // `temperature`/`max_tokens` (as older rate code passed) are dropped by
      // validation, so the cap silently no-op'd. Build it here, and only send it
      // when a value is set so a host that passes neither keeps SDK defaults.
      const temp = input.temperature ?? options.defaultTemperature;
      const predict = input.maxTokens ?? options.defaultMaxTokens;
      const generationParams =
        temp !== undefined || predict !== undefined
          ? {
              ...(temp !== undefined ? { temp } : {}),
              ...(predict !== undefined ? { predict } : {}),
            }
          : undefined;

      const run = options.completion({
        modelId,
        history,
        stream: true,
        // Split `<think>` into separate thinkingDelta events so reasoning never
        // pollutes the visible answer.
        captureThinking: true,
        ...(generationParams ? { generationParams } : {}),
        ...(tools ? { tools } : {}),
      } as unknown as Parameters<CompletionFn>[0]);

      const maxThinkingTokens = input.maxThinkingTokens ?? options.maxThinkingTokens;
      const result = await consumeRun(run, {
        onToken: input.onToken,
        onThinking: input.onThinking ?? options.onThinking,
        maxThinkingTokens,
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
      const totalTokens = result.stats?.totalTokens;
      const promptTokens = result.stats?.promptTokens;
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

      return {
        text,
        rawContent: result.rawContent,
        toolCalls: result.toolCalls,
        requestId: result.requestId,
        inference,
      };
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
