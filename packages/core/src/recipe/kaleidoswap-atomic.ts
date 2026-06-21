/**
 * Built-in "swap on KaleidoSwap" recipe — the real atomic-swap chain.
 *
 * A swap (especially the full maker + RLN atomic) is a 6-step, two-service flow
 * no small model can plan reliably, so the recipe carries the plan. The model
 * is used for natural-language understanding of the request (slot extraction).
 *
 *   "buy 1 usdt"  (or "swap 10 usdt to btc")
 *     ↓ heuristic pre-filter (0 inf) decides to enter the reliable recipe branch
 *     ↓ 1 model inference (forced LLM slot extraction — the model parses intent)
 *   kaleidoswap_get_quote        ← MAKER  prices the swap (read-only)
 *     ↓ [ONE confirmation gate — shows the real quote numbers]
 *   kaleidoswap_atomic_init      ← MAKER  locks the swap → swapstring, payment_hash
 *   rln_get_node_info            ← NODE   read pubkey (= taker_pubkey)
 *   rln_atomic_taker             ← NODE   whitelist the swapstring (taker accepts)
 *   kaleidoswap_atomic_execute   ← MAKER  settle (final)
 *
 * `forceModelExtract` ensures the model is always consulted for slot parsing
 * (1 inference) so natural language like "buy 1 usdt" is interpreted by the LLM.
 * A safety fallback in the runner uses the deterministic extractor if the model
 * returns incomplete slots. The execution sequence + single-confirm gate remain
 * fully deterministic and reliable.
 *
 * Status is NOT polled here — settlement takes seconds-to-minutes and blocking
 * the chat is bad UX. The recipe reports "submitted, settling"; the user (or a
 * follow-up turn) calls `kaleidoswap_atomic_status` on demand.
 *
 * Confirmation: the single decision a user makes is "given this quote, proceed?"
 * — so the recipe declares ONE `confirm(ctx)` summary, fired after the quote and
 * before init. init/whitelist/execute then run as one approved unit. (The
 * runner's recipe-level confirm path handles this; see recipe/runner.ts.)
 */

import type { Recipe, RecipeContext } from './types.js';
import { extractSwap } from './swap.js';

// KaleidoSwap is a BTC↔RGB ATOMIC swap venue (maker + RLN node). It is NOT the
// only swap venue anymore — Flashnet (Spark-native AMM, BTC↔Spark tokens like
// USDB) is a sibling, handled by the agentic `flashnet-swaps` skill. The Funnel
// runs recipes BEFORE skills, so a greedy "any swap word" match here would
// monopolize every swap and starve Flashnet. To let both coexist, this recipe
// only claims swaps that point at ITS venue:
//   - names an RGB/maker asset or the venue itself (RGB_CUE), AND
//   - does NOT name a Flashnet/Spark cue (FLASHNET_CUE → defer to the skill).
// A bare "swap" with no venue cue falls through to the agentic tier, where the
// skill selector disambiguates (or the model asks).
const RGB_CUE = /\b(usdt|tether|xaut|gold|rgb|kaleidoswap|kaleido|atomic)\b/i;
const FLASHNET_CUE = /\b(flashnet|usdb|spark)\b/i;
const SWAP_INTENT = (t: string) => {
  // Explanatory / educational questions → route to RAG-backed agentic answer,
  // not the deterministic spend chain.
  if (/\b(why|how|what|when|explain|tell\s+me|do\s+I\s+need|should\s+I|can\s+I)\b/i.test(t)) return false;
  // Flashnet owns its venue — defer to the flashnet-swaps skill.
  if (FLASHNET_CUE.test(t)) return false;
  const swapVerb = /\b(swap|exchange|convert|trade)\b/i.test(t);
  const buyVerb =
    /\b(buy|sell|get|purchase|acquire)\b/i.test(t) &&
    // Exclude commerce / receive / LSPS1 channel-order phrasings that share
    // the buy/get verb. "Buy a USDT channel" is a channel order, not a swap.
    !/\b(gift\s?card|top-?up|esim|voucher|invoice|address|channel|inbound|liquidity|lsps?\b)\b/i.test(t);
  // Only claim the swap when an RGB/maker asset (or the venue) is named, so a
  // bare/ambiguous "swap" or a Flashnet-asset swap doesn't get grabbed here.
  if (swapVerb || buyVerb) return RGB_CUE.test(t);
  return false;
};

interface QuoteResult {
  rfq_id?: string;
  from_asset?: { asset_id?: string; ticker?: string; amount?: number };
  to_asset?: { asset_id?: string; ticker?: string; amount?: number };
  from_amount_display?: string;
  to_amount_display?: string;
  fee_display?: string;
}
interface InitResult { swapstring?: string; payment_hash?: string; atomic_id?: string }
interface NodeInfo { pubkey?: string }

export const kaleidoswapAtomicRecipe: Recipe = {
  name: 'kaleidoswap-atomic',
  description:
    'Swap between BTC and an RGB asset on KaleidoSwap: quote, confirm once, then init (maker) → whitelist (node) → execute (maker).',
  match: (t) => SWAP_INTENT(t),
  triggers: ['swap', 'exchange', 'convert', 'trade', 'buy', 'sell'],
  slots: [
    { name: 'from_asset', type: 'string', description: 'Asset to spend (BTC / USDT / XAUT). Example: "swap 10 usdt to btc" → from_asset=USDT', required: true },
    { name: 'to_asset', type: 'string', description: 'Asset to receive (BTC / USDT / XAUT). Example: "buy 1 usdt" → to_asset=USDT', required: true },
    { name: 'amount', type: 'number', description: 'The amount the user named (in from_asset units for sell, to_asset for buy). E.g. "buy 1 usdt" amount=1; "swap 100000 sats" amount=100000' },
    { name: 'amount_side', type: 'string', description: "Which leg the amount is on: 'from' (sell/swap) or 'to' (buy). Use examples in descriptions and 'buy X Y' means to_asset." },
  ],
  // Keep the fast `extract` for the Funnel's cheap pre-filter (so "buy 1 usdt"
  // reliably enters the recipe branch instead of falling to free agentic).
  // `forceModelExtract` makes runRecipe ignore the deterministic result and
  // always ask the model to produce the actual slots used for execution.
  extract: extractSwap,
  forceModelExtract: true,
  confident: (s) => !!s.from_asset && !!s.to_asset && !!s.amount,
  steps: [
    // 1. MAKER quotes the swap (read-only). Returns rfq_id + full asset specs
    //    (echoes the rgb: asset ids and maker-unit amounts) + *_display strings.
    {
      tool: 'kaleidoswap_get_quote',
      as: 'quote',
      args: (ctx) => ({
        from_asset: ctx.slots.from_asset,
        to_asset: ctx.slots.to_asset,
        amount: ctx.slots.amount,
        // 'to' for buy ("buy 1 USDT" → amount is what you RECEIVE); default
        // 'from' for sell/swap. The host puts the amount on the right leg.
        amount_side: ctx.slots.amount_side ?? 'from',
      }),
    },
    // 2. MAKER locks the swap. SwapRequest is flat (asset ids + maker-unit
    //    amounts) — sourced straight from the quote result, no re-scaling.
    //    First spend step → the recipe-level confirm gate fires just before it.
    {
      tool: 'kaleidoswap_atomic_init',
      as: 'init',
      args: (ctx) => {
        const q = ctx.results.quote as QuoteResult | undefined;
        return {
          rfq_id: q?.rfq_id,
          from_asset: q?.from_asset?.asset_id,
          from_amount: q?.from_asset?.amount,
          to_asset: q?.to_asset?.asset_id,
          to_amount: q?.to_asset?.amount,
        };
      },
    },
    // 3. NODE: read our pubkey — the maker needs it as taker_pubkey for execute.
    {
      tool: 'rln_get_node_info',
      as: 'node',
      args: () => ({}),
    },
    // 4. NODE: the taker whitelists the maker's swapstring (accept the swap).
    //    Exposed by kaleido-mcp as `rln_atomic_taker` (calls rln.whitelistSwap).
    //    Ungated — covered by the single confirm above.
    {
      tool: 'rln_atomic_taker',
      as: 'whitelist',
      args: (ctx) => {
        const init = ctx.results.init as InitResult | undefined;
        return { swapstring: init?.swapstring };
      },
    },
  ],
  // 5. MAKER settles the swap. Needs swapstring + taker_pubkey + payment_hash.
  final: {
    tool: 'kaleidoswap_atomic_execute',
    args: (ctx) => {
      const init = ctx.results.init as InitResult | undefined;
      const node = ctx.results.node as NodeInfo | undefined;
      return {
        swapstring: init?.swapstring,
        taker_pubkey: node?.pubkey,
        payment_hash: init?.payment_hash,
      };
    },
  },
  // ONE confirmation, fired after the quote / before init, with the real numbers.
  confirm: (ctx: RecipeContext) => {
    const q = ctx.results.quote as QuoteResult | undefined;
    const from = q?.from_amount_display ?? `${ctx.slots.amount} ${ctx.slots.from_asset}`;
    const to = q?.to_amount_display ?? String(ctx.slots.to_asset);
    const fee = q?.fee_display ? ` · fee ${q.fee_display}` : '';
    return `Swap ${from} → ${to}${fee} on KaleidoSwap. Proceed?`;
  },
  summary: (ctx) => {
    const q = ctx.results.quote as QuoteResult | undefined;
    const from = q?.from_amount_display ?? `${ctx.slots.amount} ${ctx.slots.from_asset}`;
    const to = q?.to_amount_display ?? String(ctx.slots.to_asset);
    const init = ctx.results.init as InitResult | undefined;
    const id = init?.atomic_id || init?.payment_hash || '?';
    return `remember: atomic swap atomic_id=${id} (for later kaleidoswap_atomic_status checks).
Swap submitted: ${from} → ${to}. To check status later, call: kaleidoswap_atomic_status(atomic_id=${id}). Say "check my swap status" and I will recall + poll automatically.`;
  },
};
