/**
 * Price / rate / "how much" recipe — quote-only.
 *
 * A price question is NOT a swap. The user wants the rate, not to move funds.
 * This recipe fires the maker quote (with amount=1 on the asked-about asset)
 * and stops — no init, no execute, no confirmation gate. The user can then
 * say "ok, do it" if they want to actually swap, which routes to the atomic
 * recipe.
 *
 *   "what is the price of usdt in sats"  → quote {from:BTC,  to:USDT, amt 1 on TO}
 *   "btc price"                          → quote {from:USDT, to:BTC,  amt 1 on TO}
 *   "how much sats for 1 usdt"           → quote {from:BTC,  to:USDT, amt 1 on TO}
 *
 * Disjoint from `kaleidoswapAtomicRecipe`: this matches PRICE phrasings only;
 * the atomic recipe matches swap/buy/sell phrasings only. Order matters in
 * the Funnel's recipe list — register the price recipe FIRST so a phrase
 * like "what's the BTC price" never reaches the swap recipe.
 */

import type { Recipe, RecipeContext } from './types.js';
import { extractPriceQuery } from './swap.js';

const ASSET = /\b(btc|bitcoin|sats?|usdt|tether|xaut|gold)\b/i;
// Flashnet (Spark AMM) cues — a price/rate question aimed at a Flashnet asset
// or venue should NOT be quoted via the KaleidoSwap maker. Defer to the
// agentic tier (flashnet-swaps simulate_swap is the read-only quote there).
const FLASHNET_CUE = /\b(flashnet|usdb|spark)\b/i;
const PRICE_INTENT = (t: string) =>
  /\b(price|rate|cost|worth|how\s+(?:much|many))\b/i.test(t) &&
  ASSET.test(t) &&
  !FLASHNET_CUE.test(t);

interface QuoteResult {
  rfq_id?: string;
  from_amount_display?: string;
  to_amount_display?: string;
  fee_display?: string;
}

export const kaleidoswapPriceRecipe: Recipe = {
  name: 'kaleidoswap-price',
  description:
    'Quote the rate of one asset in another (read-only, no swap). Triggered by "price of X", "X price", "rate of X", "how much is X", "cost of X".',
  match: (t) => PRICE_INTENT(t),
  triggers: ['price', 'rate', 'cost', 'worth'],
  slots: [
    { name: 'from_asset', type: 'string', description: 'Denomination (the unit you want the price IN)', required: true },
    { name: 'to_asset', type: 'string', description: 'The asset whose price you want', required: true },
    { name: 'amount', type: 'number', description: 'Always 1 — pricing a unit of to_asset', required: true },
    { name: 'amount_side', type: 'string', description: "Always 'to' — the amount sits on the priced leg" },
  ],
  extract: extractPriceQuery,
  confident: (s) => !!s.from_asset && !!s.to_asset,
  // No intermediate steps; the quote is the final action. It is read-only,
  // so no confirmation gate fires — and there's no spend after it.
  steps: [],
  final: {
    tool: 'kaleidoswap_get_quote',
    as: 'quote',
    args: (ctx) => ({
      from_asset: ctx.slots.from_asset,
      to_asset: ctx.slots.to_asset,
      amount: ctx.slots.amount ?? 1,
      amount_side: ctx.slots.amount_side ?? 'to',
    }),
  },
  summary: (ctx: RecipeContext) => {
    const q = ctx.results.quote as QuoteResult | undefined;
    const from = q?.from_amount_display;
    const to = q?.to_amount_display;
    if (from && to) return `${to} = ${from}.`;
    return `Quoted ${ctx.slots.to_asset} at 1 unit.`;
  },
};
