/**
 * Pure mapping from a QVAC completion `final` frame to the shape the shared
 * @kaleidorg/mind Engine consumes. Kept SDK-free (structural input type) so it
 * is testable without loading a model, and so the same mapping runs on mobile,
 * desktop, and the eval harness.
 */
import type { ToolCallError } from '../providers/types.js';
import { cleanAssistantVisibleText } from './text.js';

/**
 * Per-turn inference stats from a QVAC `completion().final.stats` frame. The
 * authoritative source for which backend actually ran (`backendDevice`) and the
 * real throughput — hosts surface these instead of guessing from load config.
 */
export interface QvacTurnStats {
  /** The backend that actually executed this turn — the real "is GPU active". */
  backendDevice?: 'cpu' | 'gpu';
  tokensPerSecond?: number;
  totalTokens?: number;
  promptTokens?: number;
  /** Tokens generated this turn (what the SDK reports; `totalTokens` is not emitted). */
  generatedTokens?: number;
  timeToFirstToken?: number;
  contextSize?: number;
  totalTime?: number;
}

/** Structural subset of a QVAC `completion().final` we depend on. */
export interface QvacFinalLike {
  /** Visible assistant text (excludes `<think>` reasoning). */
  contentText?: string;
  /** Raw assistant frame, incl. tool-call framing, for history push-back. */
  raw?: { fullText?: string };
  /** Tool calls the model requested this turn (empty ⇒ final answer). */
  toolCalls?: Array<{ id?: string; name: string; arguments?: Record<string, unknown> }>;
  /** Tool-call regions that failed to parse or validate (QVAC 0.20+; omitted when none). */
  toolErrors?: ToolCallError[];
  /**
   * Why generation stopped: `"length"` when the token budget is exhausted,
   * `"cancelled"` on abort, `"eos"`/`"stopSequence"`/`undefined` on a natural stop. We surface
   * it so the funnel can tell a truncated tool-call from a complete one.
   */
  stopReason?: 'length' | 'cancelled' | string;
  /** Inference stats (backend device, throughput). Present on a natural finish. */
  stats?: QvacTurnStats;
}

export interface ParsedTurn {
  /** Cleaned assistant content for display. */
  text: string;
  /** Raw assistant frame to push back into history for the next turn. */
  rawContent: string;
  /** Tool calls the model requested (arguments defaulted to `{}`). */
  toolCalls: Array<{ id?: string; name: string; arguments: Record<string, unknown> }>;
  /** Tool-call attempts the SDK could not parse, when no call was recovered from text. */
  toolErrors?: ToolCallError[];
  /** True when generation was cut off by the token budget (incomplete output). */
  truncated: boolean;
  /** Raw stop reason from the SDK, when provided. */
  stopReason?: string;
  /** Inference stats for this turn (backend device, throughput), when provided. */
  stats?: QvacTurnStats;
}

/** Parse the first balanced `{…}` from a string as a `{name, arguments}` call. */
function parseCallObject(
  s: string,
): { name: string; arguments: Record<string, unknown> } | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        const obj = JSON.parse(s.slice(start, i + 1)) as {
          name?: unknown;
          arguments?: unknown;
        };
        if (obj && typeof obj.name === 'string') {
          const args =
            obj.arguments && typeof obj.arguments === 'object'
              ? (obj.arguments as Record<string, unknown>)
              : {};
          return { name: obj.name, arguments: args };
        }
      } catch {
        /* malformed JSON — give up on this fragment */
      }
      return null;
    }
  }
  return null;
}

/**
 * Parse Qwen3.5's XML call body:
 * `<function=name><parameter=key>value</parameter>…</function>`. Values that
 * read as JSON (numbers, booleans, arrays, objects) are decoded; the rest stay
 * strings.
 */
function parseXmlCall(s: string): { name: string; arguments: Record<string, unknown> } | null {
  const fn = s.match(/<function=([^>\s]+)\s*>([\s\S]*?)(?:<\/function>|$)/i);
  if (!fn?.[1]) return null;
  const args: Record<string, unknown> = {};
  for (const m of (fn[2] ?? '').matchAll(/<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/gi)) {
    const raw = (m[2] ?? '').trim();
    let value: unknown = raw;
    if (/^(-?\d+(\.\d+)?|true|false|null|\[[\s\S]*\]|\{[\s\S]*\})$/.test(raw)) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    args[m[1]!] = value;
  }
  return { name: fn[1], arguments: args };
}

/**
 * Recover tool calls a model emitted as PLAIN TEXT instead of structured frames
 * — `<tool_call>{"name":…,"arguments":…}</tool_call>` (Qwen/Hermes) or a bare
 * leading `{"name":…,"arguments":…}`. Small local models (and SDK builds that
 * don't apply the tool grammar) do this; without recovery the call leaks into
 * the visible answer and never runs.
 */
export function extractTextToolCalls(
  text: string,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  for (const m of text.matchAll(/<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi)) {
    const body = m[1] ?? '';
    const c = parseCallObject(body) ?? parseXmlCall(body);
    if (c) calls.push(c);
  }
  if (calls.length) return calls;
  // No tags — accept a bare tool-call object only at the very start of the
  // text (so we don't misread JSON the model is merely talking about).
  if (/^\s*\{?\s*"name"\s*:/i.test(text)) {
    const c = parseCallObject(text);
    if (c) calls.push(c);
  }
  return calls;
}

/**
 * Map a completion `final` (plus the streamed fallback text) into a ParsedTurn.
 * `rawContent` prefers the SDK's framed `raw.fullText` so the Engine can anchor
 * the next turn; falls back to the visible text when a provider has no raw form.
 *
 * When the SDK reports no structured tool calls, we re-scan the raw text for
 * tool calls the model emitted inline (see `extractTextToolCalls`) so they still
 * execute instead of leaking into the chat.
 */
export function finalToTurn(final: QvacFinalLike, streamed = ''): ParsedTurn {
  const rawText = final.contentText || streamed;
  const text = cleanAssistantVisibleText(rawText);
  let toolCalls = (final.toolCalls ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    arguments: c.arguments ?? {},
  }));
  if (toolCalls.length === 0) {
    const recovered = extractTextToolCalls(final.raw?.fullText ?? rawText);
    if (recovered.length) toolCalls = recovered.map((c) => ({ id: undefined, ...c }));
  }
  return {
    text,
    rawContent: final.raw?.fullText ?? rawText,
    toolCalls,
    ...(toolCalls.length === 0 && final.toolErrors?.length ? { toolErrors: final.toolErrors } : {}),
    truncated: final.stopReason === 'length',
    stopReason: final.stopReason,
    stats: final.stats,
  };
}
