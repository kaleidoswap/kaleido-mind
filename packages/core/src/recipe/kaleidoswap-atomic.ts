/**
 * Built-in "atomic swap on KaleidoSwap" recipe — trust-minimised chain.
 *
 * Most users want the simple market-order swap (`swapRecipe` over generic
 * `get_swap_quote` / `execute_swap`). This recipe is the EXPLICIT atomic path:
 * the user creates an RGB/LN receive invoice, the maker locks the swap, the
 * user pays the maker's Lightning invoice, and the maker releases.
 *
 * Triggered only by explicit atomic-swap intent ("atomic swap", "trustless
 * swap", "htlc swap") so it never preempts the simpler swap path for vague
 * phrasings.
 *
 *   "atomic swap 100000 sats for usdt"
 *     ↓ 1 model inference (slot extraction)
 *   kaleidoswap_get_quote        ← maker prices the swap
 *   rln_create_rgb_invoice       ← user's node prepares receive (if to_asset is RGB)
 *   rln_create_ln_invoice        ← (alt) if to_asset is BTC
 *   kaleidoswap_atomic_init  🔒 ← maker locks the swap, returns its invoice
 *   rln_pay_invoice          🔒 ← user pays the maker
 *   kaleidoswap_atomic_execute 🔒 ← (final) maker releases the asset
 *
 * Two-or-three confirmation gates are intentional: each represents a distinct
 * decision point. The host's confirm UI describes what's about to happen.
 */

import type { Recipe } from './types.js';
import { extractSwap } from './swap.js';

const ATOMIC_INTENT =
  /\b(atomic|trustless|htlc)\b.*\b(swap|exchange|convert|trade)\b|\b(swap|exchange|convert|trade)\b.*\b(atomic|trustless|htlc)\b/i;

function isBtc(asset: unknown): boolean {
  return String(asset ?? '').toUpperCase() === 'BTC';
}

export const kaleidoswapAtomicRecipe: Recipe = {
  name: 'kaleidoswap-atomic',
  description:
    'Trust-minimised atomic swap on KaleidoSwap: quote, prepare a receive invoice on the user\'s node, lock the swap with the maker, pay, and execute.',
  match: (t) => ATOMIC_INTENT.test(t),
  triggers: ['atomic swap', 'trustless swap', 'htlc swap'],
  slots: [
    { name: 'from_asset', type: 'string', description: 'Asset to spend (BTC / USDT / XAUT)', required: true },
    { name: 'to_asset', type: 'string', description: 'Asset to receive (BTC / USDT / XAUT)', required: true },
    { name: 'amount', type: 'number', description: 'Amount of from_asset to swap' },
  ],
  extract: extractSwap,
  confident: (s) => !!s.from_asset && !!s.to_asset && !!s.amount,
  steps: [
    // 1. Maker quotes the swap. Returns { quote_id, receive_amount, fees, ttl_ms, ... }.
    {
      tool: 'kaleidoswap_get_quote',
      as: 'quote',
      args: (ctx) => ({
        from_asset: ctx.slots.from_asset,
        to_asset: ctx.slots.to_asset,
        amount: ctx.slots.amount,
      }),
    },
    // 2a. User's node creates an RGB receive invoice (when to_asset is an RGB asset).
    {
      tool: 'rln_create_rgb_invoice',
      as: 'receive_rgb',
      args: (ctx) => {
        const q = ctx.results.quote as { receive_amount?: number } | undefined;
        return { asset: ctx.slots.to_asset, amount: q?.receive_amount };
      },
      skipIf: (ctx) => isBtc(ctx.slots.to_asset),
    },
    // 2b. User's node creates an LN receive invoice (when to_asset is BTC).
    {
      tool: 'rln_create_ln_invoice',
      as: 'receive_ln',
      args: (ctx) => {
        const q = ctx.results.quote as { receive_amount?: number } | undefined;
        return { amount_sats: q?.receive_amount };
      },
      skipIf: (ctx) => !isBtc(ctx.slots.to_asset),
    },
    // 3. Maker locks the swap. Returns { atomic_id, maker_invoice }. Spend-gated.
    {
      tool: 'kaleidoswap_atomic_init',
      as: 'atomic',
      args: (ctx) => {
        const rgb = ctx.results.receive_rgb as { invoice?: string } | undefined;
        const ln = ctx.results.receive_ln as { invoice?: string } | undefined;
        const q = ctx.results.quote as { quote_id?: string } | undefined;
        return {
          quote_id: q?.quote_id,
          receive_invoice: rgb?.invoice ?? ln?.invoice,
        };
      },
    },
    // 4. User pays the maker's Lightning invoice. Spend-gated by the wallet contract.
    {
      tool: 'rln_pay_invoice',
      as: 'paid',
      args: (ctx) => {
        const a = ctx.results.atomic as { maker_invoice?: string } | undefined;
        return { invoice: a?.maker_invoice };
      },
    },
  ],
  // 5. Maker releases the receive asset → swap completes. Spend-gated.
  final: {
    tool: 'kaleidoswap_atomic_execute',
    args: (ctx) => {
      const a = ctx.results.atomic as { atomic_id?: string } | undefined;
      return { atomic_id: a?.atomic_id };
    },
  },
  summary: (ctx) => {
    const q = ctx.results.quote as { receive_amount?: number } | undefined;
    const tail = q?.receive_amount ? ` ≈ ${q.receive_amount} ${ctx.slots.to_asset}` : '';
    return `Atomic swap: ${ctx.slots.amount} ${ctx.slots.from_asset} → ${ctx.slots.to_asset}${tail}.`;
  },
};
