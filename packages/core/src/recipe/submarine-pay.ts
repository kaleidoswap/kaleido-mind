/**
 * "Pay this Lightning invoice with my Liquid USDT" — a submarine swap on the
 * KaleidoSwap /v2 maker:
 *
 *   "pay lntbs1… with L-USDT"           → kaleidoswap_submarine_create → 🔒 kaleidoswap_submarine_fund
 *   "paga lntbs1… con USDT su Liquid"   → same
 *
 * One confirmation, shown after `create` so the user sees the exact amount the
 * maker asked for (fees included) before anything is locked. Keys never reach
 * the model; `fund` takes only the swap id. Opt-in: register via
 * `Funnel.recipes` BEFORE the generic payments recipe on hosts that bind the
 * submarine tools.
 */

import type { Recipe, RecipeContext } from './types.js';
import { formatSubmarineAmount } from '../submarine/contract.js';

const INVOICE = /\b(ln(?:bcrt|tbs|bc|tb)[0-9a-z]{20,})\b/i;
// Only an explicit Liquid asset: a bare "USDT" is RGB USDT (atomic recipe), not L-USDT.
const L_USDT = /\b(l-?usdt|usdt[- ]?l|liquid[- ]usdt|usdt (?:on|su|in) liquid|usdt liquid)\b/i;
const L_BTC = /\b(l-?btc|liquid[- ]btc|liquid bitcoin|btc (?:on|su|in) liquid|bitcoin (?:on|su|in) liquid)\b/i;

/** Tool results may arrive as JSON text (MCP) or objects (in-process). */
function obj(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    try { return JSON.parse(v) as Record<string, unknown>; } catch { return {}; }
  }
  return (v ?? {}) as Record<string, unknown>;
}

function shortInvoice(inv: string): string {
  return `${inv.slice(0, 10)}…${inv.slice(-6)}`;
}

export function extractSubmarinePay(text: string): Record<string, unknown> | null {
  const invoice = text.match(INVOICE)?.[1];
  if (!invoice) return null;
  const from_asset = L_USDT.test(text) ? 'L-USDT' : L_BTC.test(text) ? 'L-BTC' : undefined;
  if (!from_asset) return null;
  return { invoice, from_asset };
}

export const submarinePayRecipe: Recipe = {
  name: 'submarine-pay',
  description: 'Pay a Lightning invoice from Liquid funds (L-USDT or L-BTC) via a KaleidoSwap submarine swap — one confirmation.',
  match: (t) => INVOICE.test(t) && (L_USDT.test(t) || L_BTC.test(t)),
  triggers: ['l-usdt', 'liquid usdt', 'l-btc', 'submarine'],
  slots: [
    { name: 'invoice', type: 'string', description: 'BOLT11 Lightning invoice to pay', required: true },
    { name: 'from_asset', type: 'string', description: 'L-USDT or L-BTC', required: true },
  ],
  extract: extractSubmarinePay,
  confident: (s) => typeof s.invoice === 'string' && (s.from_asset === 'L-USDT' || s.from_asset === 'L-BTC'),
  steps: [
    {
      tool: 'kaleidoswap_submarine_create',
      as: 'swap',
      args: (ctx) => ({ invoice: ctx.slots.invoice, from_asset: ctx.slots.from_asset }),
    },
  ],
  confirm: (ctx: RecipeContext) => {
    const swap = obj(ctx.results.swap);
    const asset = String(swap.from_asset ?? ctx.slots.from_asset);
    return `Pay Lightning invoice ${shortInvoice(String(ctx.slots.invoice))} with ${formatSubmarineAmount(asset, swap.expected_amount)} (fees included) through a KaleidoSwap submarine swap. Confirm?`;
  },
  final: {
    tool: 'kaleidoswap_submarine_fund',
    args: (ctx) => ({ swap_id: obj(ctx.results.swap).swap_id }),
  },
  summary: (ctx, final) => {
    const swap = obj(ctx.results.swap);
    const funded = obj(final);
    const asset = String(swap.from_asset ?? ctx.slots.from_asset);
    return `Locked ${formatSubmarineAmount(asset, swap.expected_amount)} in swap ${String(swap.swap_id)}` +
      (funded.txid ? ` (tx ${String(funded.txid).slice(0, 12)}…)` : '') +
      '. The maker pays the invoice once the lockup is seen — ask me for the swap status to follow it.';
  },
};
