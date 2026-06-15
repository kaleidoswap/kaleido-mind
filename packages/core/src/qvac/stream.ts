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
}

export interface ConsumedTurn extends ParsedTurn {
  requestId: string;
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
  let streamed = '';
  for await (const event of run.events) {
    if (event.type === 'contentDelta' && typeof event.text === 'string') {
      streamed += event.text;
      handlers.onToken?.(event.text);
    } else if (event.type === 'thinkingDelta' && typeof event.text === 'string') {
      handlers.onThinking?.(event.text);
    }
  }
  const final = await run.final;
  return { ...finalToTurn(final, streamed), requestId: run.requestId };
}
