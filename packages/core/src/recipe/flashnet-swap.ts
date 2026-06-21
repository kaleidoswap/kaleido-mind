/**
 * Built-in "swap on Flashnet" recipe — Spark-native AMM, deterministic chain.
 *
 * A Flashnet swap on a small model was fragile when left to the agentic loop:
 * the model had to discover the pool, get the asset addresses right, pick the
 * correct simulate DIRECTION (asset_in = what the user spends), compute
 * `min_amount_out` from slippage tolerance, and then thread all of that into
 * execute. With Qwen3-1.7B that often produced an inverted simulate (token →
 * BTC instead of BTC → token), and on the follow-up "yes" the skill context
 * was lost and the model called `flashnet_simulate_swap({})` with no args.
 *
 *   "swap 10000 sats with usdb"
 *     ↓ 1 model inference (slot extraction: from/to/amount/amount_side)
 *   flashnet_list_pools           ← discover the right pool deterministically
 *     ↓
 *   flashnet_simulate_swap        ← quote (read-only)
 *     ↓ [ONE confirmation gate — shows the real quote in plain English]
 *   flashnet_execute_swap         ← settle (the spend)
 *
 * The whole chain runs with 1 LLM inference total (slot extraction), same
 * pattern as `kaleidoswapAtomicRecipe`. The host's `flashnet_list_pools` is
 * side-agnostic and labels symbols, so picking the right pool from the
 * extracted asset pair is cheap and reliable.
 *
 * Slippage: default `max_slippage_bps = 50` (0.5%). The runner computes
 * `min_amount_out = floor(amount_out × (1 − bps/10000))` from the simulate
 * result before execute — never trusts the simulated value as-is.
 *
 * Asset taxonomy guard: matches ONLY when a Flashnet cue is present
 * (flashnet/usdb/spark), so RGB swaps (USDT/XAUT) still go to the
 * KaleidoSwap atomic recipe. The two recipes are disjoint.
 */

import type { Recipe, RecipeContext } from './types.js';
import { extractSwap } from './swap.js';

// Flashnet cue — same set the kaleidoswap-atomic recipe defers ON, so the
// two are disjoint by construction.
const FLASHNET_CUE = /\b(flashnet|usdb|spark)\b/i;
// Spark-token tickers that imply a Flashnet swap even without "flashnet" in
// the text. Keep this list small and Spark-specific — never includes RGB
// assets (USDT, XAUT, gold).
const SPARK_TOKEN = /\b(usdb)\b/i;
// Generic swap-intent verbs that pair with an asset name. "buy/sell/get" join
// the swap intent only when an ASSET is named (so "buy a gift card" doesn't
// route here — that's bitrefill territory).
const SWAP_VERB = /\b(swap|exchange|convert|trade)\b/i;
const BUY_VERB = /\b(buy|sell|get|purchase|acquire)\b/i;
const ASSET = /\b(btc|bitcoin|sats?|usdb)\b/i;
const NON_SWAP = /\b(gift\s?card|top-?up|esim|voucher|invoice|address|channel|inbound|liquidity|lsps?\b)\b/i;

const FLASHNET_INTENT = (t: string) => {
  // Educational questions go to the agentic skill (which can call list_pools
  // for an honest read).
  if (/\b(why|how|what|when|explain|tell\s+me|do\s+I\s+need|should\s+I|can\s+I)\b/i.test(t)) return false;
  // Must have a Flashnet/Spark cue OR name a Spark-native token like USDB,
  // so this never grabs an RGB swap (those go to kaleidoswap-atomic).
  if (!FLASHNET_CUE.test(t) && !SPARK_TOKEN.test(t)) return false;
  if (NON_SWAP.test(t)) return false;
  if (SWAP_VERB.test(t)) return true;
  if (BUY_VERB.test(t) && ASSET.test(t)) return true;
  return false;
};

// ── Shape helpers (decoupled from the SDK's exact field names; the host
//    adapter normalizes responses to these). ────────────────────────────────
interface PoolRow {
  pool_id: string;
  asset_a_address: string;
  asset_b_address: string;
  asset_a_symbol?: string;
  asset_b_symbol?: string;
  curve_type?: string;
  tvl_asset_b?: string;
  fee_bps?: number;
}
interface ListPoolsResult { pools: PoolRow[]; total_count?: number }
interface SimulateResult {
  amount_out?: string;
  execution_price?: string;
  price_impact_pct?: string;
  fee_paid_asset_in?: string;
  warning?: string;
}
interface ExecuteResult {
  accepted?: boolean;
  request_id?: string;
  amount_out?: string;
  execution_price?: string;
}

/**
 * Resolve the asset address pair from a pool row + the user's requested
 * (from_asset, to_asset) symbols. The pool stores ONE order (typically the
 * non-BTC token on side A, BTC on side B), but the user can phrase the swap
 * either direction.
 *
 * Strategy — deduce the unknown side from the known one:
 *   1. Match each leg to a pool side by symbol or by the BTC-ticker family.
 *   2. If one leg resolves to a side, the other leg MUST be the opposite side
 *      (a pool only has two assets). This is the case that prevented an
 *      earlier "asset_in == asset_out" bug on regtest, where the non-BTC
 *      side carries no symbol.
 *   3. Only as a last resort fall back to the "BTC on side B, token on side
 *      A" default — true for almost every regtest pool we've seen.
 */
function isBtcTicker(s: string): boolean {
  return s === 'BTC' || s === 'SATS' || s === 'BITCOIN';
}

function resolveLegAddresses(pool: PoolRow, from: string, to: string): { fromAddr: string; toAddr: string } {
  const f = (from ?? '').toUpperCase();
  const t = (to ?? '').toUpperCase();
  const aSym = (pool.asset_a_symbol ?? '').toUpperCase();
  const bSym = (pool.asset_b_symbol ?? '').toUpperCase();

  // Which side (if any) does each leg map to?
  const sideOf = (sym: string): 'a' | 'b' | undefined => {
    if (sym === aSym && aSym) return 'a';
    if (sym === bSym && bSym) return 'b';
    return undefined;
  };

  let fSide = sideOf(f);
  let tSide = sideOf(t);

  // 2. Deduce the unknown side from the known one.
  if (!fSide && tSide) fSide = tSide === 'a' ? 'b' : 'a';
  if (!tSide && fSide) tSide = fSide === 'a' ? 'b' : 'a';

  // 3. Last-resort default — only when NEITHER side resolved. BTC on side B
  //    is the canonical layout for the Spark/Flashnet pools we've observed.
  if (!fSide && !tSide) {
    fSide = isBtcTicker(f) ? 'b' : 'a';
    tSide = fSide === 'a' ? 'b' : 'a';
  }

  const addr = (side: 'a' | 'b'): string => (side === 'a' ? pool.asset_a_address : pool.asset_b_address);
  return { fromAddr: addr(fSide!), toAddr: addr(tSide!) };
}

/** Compute min_amount_out = floor(amount_out × (1 − bps/10000)). String-safe. */
function computeMinAmountOut(amountOut: string | undefined, slippageBps: number): string {
  if (!amountOut) return '0';
  try {
    const out = BigInt(String(amountOut).replace(/[^\d]/g, ''));
    const num = BigInt(10_000 - Math.max(0, Math.min(5_000, slippageBps)));
    const min = (out * num) / 10_000n;
    return min.toString();
  } catch {
    return '0';
  }
}

const DEFAULT_SLIPPAGE_BPS = 50;

export const flashnetSwapRecipe: Recipe = {
  name: 'flashnet-swap',
  description:
    "Swap on Flashnet (Spark-native AMM): list pool → simulate → confirm once → execute. The user's Spark wallet IS the swap account.",
  match: (t) => FLASHNET_INTENT(t),
  triggers: ['flashnet', 'usdb', 'swap', 'exchange', 'convert', 'trade'],
  slots: [
    { name: 'from_asset', type: 'string', description: 'Asset the user SPENDS (BTC / USDB). "swap 10000 sats with usdb" → from_asset=BTC. "sell 1 usdb" → from_asset=USDB.', required: true },
    { name: 'to_asset',   type: 'string', description: 'Asset the user GETS (BTC / USDB). "swap 10000 sats with usdb" → to_asset=USDB. "buy USDB with sats" → to_asset=USDB.', required: true },
    { name: 'amount',     type: 'number', description: 'The numeric amount the user named. e.g. "swap 10000 sats with usdb" → amount=10000. Always in the asset on `amount_side`.' },
    { name: 'amount_side', type: 'string', description: "Which leg the amount is denominated in: 'from' (the spent asset) or 'to' (the received asset). Default 'from'. 'buy 10 usdb with sats' → 'to'." },
  ],
  // extractSwap is the same regex extractor the KaleidoSwap atomic recipe
  // uses; it returns {from_asset, to_asset, amount, amount_side?}. With
  // forceModelExtract=true the runner ignores the det result and always asks
  // the model — but the det extraction still feeds the Funnel's pre-filter so
  // bare "buy/sell" with a Spark asset routes here even before the model runs.
  extract: extractSwap,
  forceModelExtract: true,
  confident: (s) => !!s.from_asset && !!s.to_asset && !!s.amount,
  steps: [
    // 1. Discover the pool. Side-agnostic on the host side; one row is enough.
    {
      tool: 'flashnet_list_pools',
      as: 'pools',
      args: (ctx) => ({
        asset_a: String(ctx.slots.from_asset ?? '').toUpperCase(),
        asset_b: String(ctx.slots.to_asset ?? '').toUpperCase(),
        sort: 'TVL_DESC',
        limit: 5,
      }),
    },
    // 2. Quote the swap. Direction is LITERAL: asset_in = what the user
    //    spends (`from_asset`), asset_out = what they get (`to_asset`). The
    //    runner — not the model — assembles this, so the inverted-direction
    //    bug is impossible by construction.
    {
      tool: 'flashnet_simulate_swap',
      as: 'sim',
      args: (ctx) => {
        const r = ctx.results.pools as ListPoolsResult | undefined;
        const pool = r?.pools?.[0];
        if (!pool) throw new Error(`No Flashnet pool found for ${ctx.slots.from_asset} ↔ ${ctx.slots.to_asset}.`);
        const { fromAddr, toAddr } = resolveLegAddresses(pool, String(ctx.slots.from_asset ?? ''), String(ctx.slots.to_asset ?? ''));
        return {
          pool_id: pool.pool_id,
          asset_in_address: fromAddr,
          asset_out_address: toAddr,
          amount_in: String(ctx.slots.amount ?? ''),
        };
      },
    },
  ],
  // 3. Settle. Confirmation-gated at the recipe level (see runner.ts).
  //    min_amount_out is computed here — never the raw simulated value — so a
  //    moving pool can't fill at a worse price than `slippage_bps` allows.
  final: {
    tool: 'flashnet_execute_swap',
    as: 'exec',
    args: (ctx) => {
      const r = ctx.results.pools as ListPoolsResult | undefined;
      const pool = r?.pools?.[0];
      const sim = ctx.results.sim as SimulateResult | undefined;
      if (!pool || !sim) throw new Error('Flashnet swap: missing pool or simulation result.');
      const { fromAddr, toAddr } = resolveLegAddresses(pool, String(ctx.slots.from_asset ?? ''), String(ctx.slots.to_asset ?? ''));
      return {
        pool_id: pool.pool_id,
        asset_in_address: fromAddr,
        asset_out_address: toAddr,
        amount_in: String(ctx.slots.amount ?? ''),
        min_amount_out: computeMinAmountOut(sim.amount_out, DEFAULT_SLIPPAGE_BPS),
        max_slippage_bps: DEFAULT_SLIPPAGE_BPS,
      };
    },
  },
  // ONE confirmation, fired after simulate / before execute, with real numbers.
  confirm: (ctx: RecipeContext) => {
    const sim = ctx.results.sim as SimulateResult | undefined;
    const from = fmtAmount(ctx.slots.amount, String(ctx.slots.from_asset ?? ''));
    const to = fmtAmount(sim?.amount_out, String(ctx.slots.to_asset ?? ''));
    const impact = sim?.price_impact_pct ? ` · ${sim.price_impact_pct} price impact` : '';
    const warn = sim?.warning ? ` · ${sim.warning}` : '';
    return `Swap ${from} → ~${to} on Flashnet (slippage cap ${DEFAULT_SLIPPAGE_BPS / 100}%)${impact}${warn}. Proceed?`;
  },
  summary: (ctx) => {
    const sim = ctx.results.sim as SimulateResult | undefined;
    const exec = ctx.results.exec as ExecuteResult | undefined;
    const from = fmtAmount(ctx.slots.amount, String(ctx.slots.from_asset ?? ''));
    const got = fmtAmount(exec?.amount_out ?? sim?.amount_out, String(ctx.slots.to_asset ?? ''));
    if (exec?.accepted === false) {
      return `Flashnet swap rejected: ${(exec as any)?.error ?? 'unknown error'}.`;
    }
    return `Flashnet swap submitted: ${from} → ${got}. request_id=${exec?.request_id ?? '?'}.`;
  },
};

/**
 * Format an amount + asset for user display. BTC is rendered as "X,XXX sats"
 * (BTC is the asset, sats is the unit; the on-the-wire amount is already in
 * sats so no conversion is needed). Anything else is rendered as
 * "N TICKER" with thousand-separators.
 */
function fmtAmount(amount: unknown, asset: string): string {
  const t = (asset ?? '').toUpperCase();
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount ?? '?'} ${t}`;
  const sep = n.toLocaleString('en-US');
  if (t === 'BTC' || t === 'SATS' || t === 'BITCOIN') return `${sep} sats`;
  return `${sep} ${t}`;
}
