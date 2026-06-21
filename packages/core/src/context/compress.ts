/**
 * Tool-output compression — the "fit more into a tiny window" part.
 *
 * Tool results are the single biggest, most repetitive thing the engine pushes
 * into a small on-device model's context. A merchant search returns 40 near
 * identical rows; a tx history returns hundreds; a swap quote nests config the
 * model never reads. Every round, the *raw* `JSON.stringify(result)` is fed back
 * into history — so on a 2k-window 0.6B model the conversation drowns in JSON
 * the model didn't need, crowding out the system prompt, the skill, and the
 * actual question.
 *
 * `compressToolResult` is a structural crusher (the idea behind Headroom's
 * SmartCrusher/ToolCrusher, reimplemented natively — no dependency, no network,
 * no proxy, so it stays on-device and private). It walks the JSON and:
 *
 *   • dedupes identical array items, then keeps the first/last few and replaces
 *     the middle with an honest `{ "__elided__": N }` marker,
 *   • caps nesting depth (deep config → a one-line summary),
 *   • truncates long *prose* strings (logs, descriptions),
 *
 * and never regresses: if crushing doesn't actually save tokens, the original
 * is returned untouched.
 *
 * SAFETY: it never touches numbers, never elides whole objects, never truncates
 * whitespace-free strings (addresses, BOLT11 invoices, txids, pubkeys), and
 * never touches a value under a money/identity key (see DEFAULT_PRESERVE_KEYS).
 * Amounts and recipients reach the model intact — the confirm readback is built
 * deterministically from the resolved call anyway, but this keeps the model's
 * own view honest too. Small results (below `minTokens`) are passed through
 * verbatim so nothing changes for the common case.
 */

import { estimateTokens } from './budget.js';

/** Keys whose values are never elided or truncated — amounts, ids, recipients. */
export const DEFAULT_PRESERVE_KEYS: readonly string[] = [
  'amount',
  'amount_sat',
  'amount_sats',
  'amount_msat',
  'sat',
  'sats',
  'msat',
  'value',
  'fee',
  'fee_sat',
  'fee_sats',
  'total',
  'total_sats',
  'balance',
  'balance_sat',
  'address',
  'invoice',
  'bolt11',
  'payment_request',
  'payment_hash',
  'preimage',
  'txid',
  'tx_id',
  'pubkey',
  'node_id',
  'recipient',
  'destination',
  'asset_id',
  'contract_id',
  'rate',
  'price',
  'price_usd',
];

export interface ToolCrushOptions {
  /** Don't compress results estimated below this many tokens. Default 200. */
  minTokens?: number;
  /** Max items kept in any array before the middle is elided. Default 8. */
  maxArrayItems?: number;
  /** Max nesting depth kept verbatim; deeper is summarized. Default 6. */
  maxDepth?: number;
  /** Max chars for a single prose string before truncation (0 disables). Default 600. */
  maxStringLength?: number;
  /** Dedupe identical array items before eliding. Default true. */
  dedupe?: boolean;
  /** Keys whose values are never elided/truncated (defaults to DEFAULT_PRESERVE_KEYS). */
  preserveKeys?: readonly string[];
}

export interface CrushResult {
  /** Serialized, compressed content — ready to push into history. */
  content: string;
  /** Estimated tokens of the original serialization. */
  originalTokens: number;
  /** Estimated tokens after crushing. */
  compressedTokens: number;
  /** Total array items dropped across the whole structure. */
  elided: number;
  /** False when the original was returned untouched (too small, or no win). */
  changed: boolean;
}

interface Resolved {
  minTokens: number;
  maxArrayItems: number;
  maxDepth: number;
  maxStringLength: number;
  dedupe: boolean;
  preserve: Set<string>;
}

/** A string with no whitespace is treated as an identifier (address/invoice/hash) and never truncated. */
function isIdentifierLike(s: string): boolean {
  return !/\s/.test(s);
}

function serialize(value: unknown): string {
  return typeof value === 'string' ? value : safeStringify(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Crush a tool result for inclusion in model context. Returns the original,
 * verbatim, when it's small or when crushing wouldn't save tokens.
 */
export function compressToolResult(value: unknown, opts: ToolCrushOptions = {}): CrushResult {
  const cfg: Resolved = {
    minTokens: opts.minTokens ?? 200,
    maxArrayItems: Math.max(2, opts.maxArrayItems ?? 8),
    maxDepth: Math.max(1, opts.maxDepth ?? 6),
    maxStringLength: opts.maxStringLength ?? 600,
    dedupe: opts.dedupe ?? true,
    preserve: new Set((opts.preserveKeys ?? DEFAULT_PRESERVE_KEYS).map((k) => k.toLowerCase())),
  };

  const original = serialize(value);
  const originalTokens = estimateTokens(original);

  // Below the floor, never touch it — correctness over savings for small results.
  if (originalTokens < cfg.minTokens) {
    return { content: original, originalTokens, compressedTokens: originalTokens, elided: 0, changed: false };
  }

  let elided = 0;
  const crushed = crush(value, cfg, 0, false, () => {
    elided += 1;
  });
  const content = serialize(crushed);
  const compressedTokens = estimateTokens(content);

  // Never regress: if crushing didn't actually shrink it, keep the original.
  if (compressedTokens >= originalTokens) {
    return { content: original, originalTokens, compressedTokens: originalTokens, elided: 0, changed: false };
  }

  return { content, originalTokens, compressedTokens, elided, changed: true };
}

/**
 * Recursively crush a JSON-ish value.
 *
 * @param preserved when true, the value sits under a preserve key — kept verbatim.
 * @param onElide   called once per array item dropped (for stats).
 */
function crush(value: unknown, cfg: Resolved, depth: number, preserved: boolean, onElide: () => void): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (preserved || isIdentifierLike(value)) return value;
    if (cfg.maxStringLength > 0 && value.length > cfg.maxStringLength) {
      const omitted = value.length - cfg.maxStringLength;
      return `${value.slice(0, cfg.maxStringLength)}… (+${omitted} chars)`;
    }
    return value;
  }

  if (typeof value !== 'object') return value; // number, boolean — never touched

  // Beyond max depth, collapse to a one-line shape summary instead of the subtree.
  if (depth >= cfg.maxDepth) {
    if (Array.isArray(value)) return `[array: ${value.length} items]`;
    return `[object: ${Object.keys(value as object).length} keys]`;
  }

  if (Array.isArray(value)) {
    let items = value;

    if (cfg.dedupe && items.length > cfg.maxArrayItems) {
      const seen = new Set<string>();
      const unique: unknown[] = [];
      for (const item of items) {
        const key = safeStringify(item);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(item);
      }
      items = unique;
    }

    if (items.length <= cfg.maxArrayItems) {
      return items.map((v) => crush(v, cfg, depth + 1, preserved, onElide));
    }

    // Keep the front and a little of the tail (Headroom's "anchors"); elide the
    // middle with an honest marker so the model knows data was omitted and can
    // ask a more specific question / call a narrower tool.
    const keepFirst = Math.max(1, Math.ceil(cfg.maxArrayItems * 0.6));
    const keepLast = Math.max(0, cfg.maxArrayItems - keepFirst);
    const head = items.slice(0, keepFirst);
    const tail = keepLast > 0 ? items.slice(items.length - keepLast) : [];
    const droppedCount = items.length - head.length - tail.length;
    for (let i = 0; i < droppedCount; i++) onElide();

    const out: unknown[] = head.map((v) => crush(v, cfg, depth + 1, preserved, onElide));
    out.push({ __elided__: droppedCount, note: 'items omitted to fit context' });
    for (const v of tail) out.push(crush(v, cfg, depth + 1, preserved, onElide));
    return out;
  }

  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    const keep = preserved || cfg.preserve.has(key.toLowerCase());
    result[key] = crush(v, cfg, depth + 1, keep, onElide);
  }
  return result;
}
