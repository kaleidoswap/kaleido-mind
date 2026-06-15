/**
 * Pure mapping from a QVAC completion `final` frame to the shape the shared
 * @kaleidorg/mind Engine consumes. Kept SDK-free (structural input type) so it
 * is testable without loading a model, and so the same mapping runs on mobile,
 * desktop, and the eval harness.
 */
import { cleanAssistantVisibleText } from './text.js';

/** Structural subset of a QVAC `completion().final` we depend on. */
export interface QvacFinalLike {
  /** Visible assistant text (excludes `<think>` reasoning). */
  contentText?: string;
  /** Raw assistant frame, incl. tool-call framing, for history push-back. */
  raw?: { fullText?: string };
  /** Tool calls the model requested this turn (empty ⇒ final answer). */
  toolCalls?: Array<{ id?: string; name: string; arguments?: Record<string, unknown> }>;
  /**
   * Why generation stopped. QVAC 0.13 emits `"length"` when the token budget is
   * exhausted, `"cancelled"` on abort, `undefined` on a natural stop. We surface
   * it so the funnel can tell a truncated tool-call from a complete one.
   */
  stopReason?: 'length' | 'cancelled' | string;
}

export interface ParsedTurn {
  /** Cleaned assistant content for display. */
  text: string;
  /** Raw assistant frame to push back into history for the next turn. */
  rawContent: string;
  /** Tool calls the model requested (arguments defaulted to `{}`). */
  toolCalls: Array<{ id?: string; name: string; arguments: Record<string, unknown> }>;
  /** True when generation was cut off by the token budget (incomplete output). */
  truncated: boolean;
  /** Raw stop reason from the SDK, when provided. */
  stopReason?: string;
}

/**
 * Map a completion `final` (plus the streamed fallback text) into a ParsedTurn.
 * `rawContent` prefers the SDK's framed `raw.fullText` so the Engine can anchor
 * the next turn; falls back to the visible text when a provider has no raw form.
 */
export function finalToTurn(final: QvacFinalLike, streamed = ''): ParsedTurn {
  const rawText = final.contentText || streamed;
  const text = cleanAssistantVisibleText(rawText);
  return {
    text,
    rawContent: final.raw?.fullText ?? rawText,
    toolCalls: (final.toolCalls ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      arguments: c.arguments ?? {},
    })),
    truncated: final.stopReason === 'length',
    stopReason: final.stopReason,
  };
}
