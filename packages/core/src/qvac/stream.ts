/**
 * Consume a QVAC `completion()` run: drain the event stream (forwarding visible
 * + thinking tokens) and fold the `final` frame into a ParsedTurn.
 *
 * Defined over a structural `CompletionRunLike` (not the SDK type) so it stays
 * SDK-free and unit-testable with a fake run — the real `CompletionRun` is
 * assignable to it. The actual `@qvac/sdk` import lives in `provider.ts`.
 */
import { finalToTurn, type ParsedTurn, type QvacFinalLike } from './parse.js';

/** Minimal shape of a QVAC completion event we react to. */
export interface CompletionEventLike {
  type: string;
  /** Present on `contentDelta` / `thinkingDelta` / `rawDelta`. */
  text?: string;
}

/** Structural subset of `completion()`'s return we depend on. */
export interface CompletionRunLike {
  requestId: string;
  events: AsyncIterable<CompletionEventLike>;
  final: Promise<QvacFinalLike>;
}

export interface StreamHandlers {
  /** Visible assistant tokens (excludes `<think>` reasoning). */
  onToken?: (token: string) => void;
  /** The model's `<think>` reasoning, streamed separately. */
  onThinking?: (token: string) => void;
  /**
   * Cap the `<think>` reasoning at this many tokens. The cap is on TOKENS, not
   * wall-clock seconds — tok/s varies by model and hardware, so a time budget is
   * unreliable; the SDK has no numeric reasoning budget (`reasoning_budget` is
   * only on/off), so we count thinking tokens and stop the run once they exceed
   * this. Omit for unlimited reasoning.
   */
  maxThinkingTokens?: number;
  /**
   * Fires once, the moment the thinking budget is exceeded, so the host can
   * cancel the in-flight run (the SDK keeps generating otherwise). consumeRun
   * stops forwarding deltas after this.
   */
  onThinkingBudgetExceeded?: () => void;
  /** Injectable monotonic-ish wall clock for deterministic timing tests. */
  now?: () => number;
}

export interface ConsumedTurn extends ParsedTurn {
  requestId: string;
  /** True when the run was stopped because `<think>` hit `maxThinkingTokens`. */
  thinkingBudgetExceeded?: boolean;
  timing: {
    ttftMs?: number;
    durationMs: number;
  };
}

/** Rough token estimate (~4 chars/token) — same heuristic the context budget uses. */
function approxTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Stream a run to completion. `contentDelta` → onToken (and the streamed
 * fallback text), `thinkingDelta` → onThinking. Returns the parsed turn plus the
 * run's `requestId` (for cancellation bookkeeping by the caller).
 */
export async function consumeRun(
  run: CompletionRunLike,
  handlers: StreamHandlers = {},
): Promise<ConsumedTurn> {
  const now = handlers.now ?? Date.now;
  const startedAt = now();
  let firstTokenAt: number | undefined;
  let streamed = '';
  let thinkingChars = 0;
  let budgetExceeded = false;
  for await (const event of run.events) {
    if (event.type === 'contentDelta' && typeof event.text === 'string') {
      if (firstTokenAt === undefined && event.text.length > 0) firstTokenAt = now();
      streamed += event.text;
      handlers.onToken?.(event.text);
    } else if (event.type === 'thinkingDelta' && typeof event.text === 'string') {
      if (firstTokenAt === undefined && event.text.length > 0) firstTokenAt = now();
      handlers.onThinking?.(event.text);
      if (handlers.maxThinkingTokens !== undefined && !budgetExceeded) {
        thinkingChars += event.text.length;
        if (approxTokens(thinkingChars) >= handlers.maxThinkingTokens) {
          budgetExceeded = true;
          handlers.onThinkingBudgetExceeded?.();
          // Stop forwarding; the host cancels the run, so `final` resolves
          // (stopReason 'cancelled') with whatever was produced so far.
          break;
        }
      }
    }
  }
  const final = await run.final;
  const finishedAt = now();
  return {
    ...finalToTurn(final, streamed),
    requestId: run.requestId,
    thinkingBudgetExceeded: budgetExceeded,
    timing: {
      ...(firstTokenAt === undefined ? {} : { ttftMs: Math.max(0, firstTokenAt - startedAt) }),
      durationMs: Math.max(0, finishedAt - startedAt),
    },
  };
}
