/**
 * Built-in "swap on KaleidoSwap" recipe — the real atomic-swap chain.
 *
 * A swap is a 6-step, two-service flow no small model can plan reliably, so the
 * recipe carries the plan; the model only extracts {from, to, amount}. The
 * maker owns init/execute/status; the user's RGB Lightning Node only exposes
 * its pubkey and whitelists the swapstring.
 *
 *   "swap 10 usdt to btc"
 *     ↓ 1 model inference (slot extraction)
 *   kaleidoswap_get_quote        ← MAKER  prices the swap (read-only)
 *     ↓ [ONE confirmation gate — shows the real quote numbers]
 *   kaleidoswap_atomic_init      ← MAKER  locks the swap → swapstring, payment_hash
 *   rln_get_node_info            ← NODE   read pubkey (= taker_pubkey)
 *   rln_whitelist_swap           ← NODE   accept the swapstring
 *   kaleidoswap_atomic_execute   ← MAKER  settle (final)
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

// Fire on plain swap intent too — there's one swap path now (atomic). The
// generic `swapRecipe` (get_swap_quote/execute_swap) is for hosts wired to a
// different venue; on the KaleidoSwap CLI this recipe is the swap.
const SWAP_INTENT = /\b(swap|exchange|convert|trade)\b/i;

interface QuoteResult {
  rfq_id?: string;
  from_asset?: { asset_id?: string; ticker?: string; amount?: number };
  to_asset?: { asset_id?: string; ticker?: string; amount?: number };
  from_amount_display?: string;
  to_amount_display?: string;
  fee_display?: string;
}
interface InitResult { swapstring?: string; payment_hash?: string }
interface NodeInfo { pubkey?: string }

export const kaleidoswapAtomicRecipe: Recipe = {
  name: 'kaleidoswap-atomic',
  description:
    'Swap between BTC and an RGB asset on KaleidoSwap: quote, confirm once, then init (maker) → whitelist (node) → execute (maker).',
  match: (t) => SWAP_INTENT.test(t),
  triggers: ['swap', 'exchange', 'convert', 'trade'],
  slots: [
    { name: 'from_asset', type: 'string', description: 'Asset to spend (BTC / USDT / XAUT)', required: true },
    { name: 'to_asset', type: 'string', description: 'Asset to receive (BTC / USDT / XAUT)', required: true },
    { name: 'amount', type: 'number', description: 'Amount of from_asset to swap' },
  ],
  extract: extractSwap,
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
    // 4. NODE: whitelist the maker's swapstring (accept the swap). Ungated —
    //    covered by the single confirm above.
    {
      tool: 'rln_whitelist_swap',
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
    return `Swap submitted: ${from} → ${to}. Settling now — ask me to check the status.`;
  },
};
