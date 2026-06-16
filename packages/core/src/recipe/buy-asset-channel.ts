/**
 * Built-in "buy an asset channel" recipe — the onboarding buy.
 *
 * The user has on-chain BTC but no Lightning channel yet, and wants to HOLD an
 * RGB asset (USDT, XAUT). They can't swap (no channel to swap inside), so they
 * buy a NEW channel from the maker LSP pre-loaded with the asset. One quote,
 * one spend:
 *
 *   "buy 100 usdt"  /  "get me 50 xaut"  /  "i want 200 usdt"
 *     ↓ 1 model inference (slot extraction; 0 when the regex hits)
 *   kaleidoswap_lsp_quote_asset_channel    ← maker prices the asset + channel
 *   kaleidoswap_lsp_create_asset_channel 🔒 ← (final) order it; pay to open
 *
 * Distinct from `swapRecipe`: a swap names a source asset ("swap 10 usdt FOR
 * btc", "buy btc WITH usdt") and needs an existing channel. This is the
 * no-source, no-channel onboarding path — "buy <amount> <asset>" with nothing
 * to spend it from — so it must be SELECTED BEFORE swap for that phrasing.
 *
 * Opt-in: register via `Funnel.recipes` (like `kaleidoswapAtomicRecipe`). The
 * host binds `kaleidoswap_lsp_*` to its transport (maker REST / MCP / WDK).
 */

import type { Recipe } from './types.js';

/** RGB assets the maker sells as an asset channel. BTC is never "bought" this way. */
const RGB_ASSET = /\b(usdt|tether|xaut|gold)\b/i;
/** A named funding source ⇒ this is a swap, not an onboarding buy. */
const HAS_SOURCE = /\b(?:with|using|from)\b|\bfor\s+(?:btc|bitcoin|sats?|usdt|xaut|tether|gold)\b/i;
/** Verbs other intents own (swap / sell / send) — never an onboarding buy. */
const NOT_BUY = /\b(swap|exchange|convert|trade|sell|send)\b/i;
/** Acquire verbs that DO mean an onboarding buy. */
const BUY_VERB = /\b(buy|get|acquire|want|purchase|onboard|need)\b/i;

function normAsset(a?: string): string | undefined {
  if (!a) return undefined;
  const x = a.toLowerCase();
  if (/usdt|tether/.test(x)) return 'USDT';
  if (/xaut|gold/.test(x)) return 'XAUT';
  return undefined;
}

const num = (s?: string): number | undefined => {
  if (!s) return undefined;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
};

/** Thousands separators, locale-independent (deterministic for tests). */
const commas = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** "buy 100 usdt" / "get me 50 xaut" / "i want 200 usdt" / "purchase 10 xaut". */
export function extractBuyAsset(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (NOT_BUY.test(t) || HAS_SOURCE.test(t)) return null;
  if (!RGB_ASSET.test(t)) return null;
  // buy/get/want/acquire/purchase [me] <amount> <asset>
  const m = t.match(/\b(?:buy|get|acquire|want|purchase|onboard|need)\b(?:\s+me)?\s+([\d.,]+)\s*([a-z]+)/i);
  if (!m) return null;
  const asset = normAsset(m[2]);
  const amount = num(m[1]);
  if (!asset || amount === undefined) return null;
  return { asset, asset_amount: amount };
}

export const buyAssetChannelRecipe: Recipe = {
  name: 'buy-asset-channel',
  description:
    'Onboarding buy: purchase a new Lightning channel pre-loaded with an RGB asset (USDT, XAUT) from the maker LSP — for a user with on-chain BTC but no channel yet. Quote, then order (with confirmation).',
  // "buy/get/want N <rgb-asset>" with NO named source asset and NO swap/send verb.
  match: (t) => !NOT_BUY.test(t) && !HAS_SOURCE.test(t) && RGB_ASSET.test(t) && BUY_VERB.test(t),
  triggers: ['buy', 'get', 'purchase', 'acquire'],
  slots: [
    { name: 'asset', type: 'string', description: 'RGB asset to acquire (USDT or XAUT)', required: true },
    { name: 'asset_amount', type: 'number', description: 'Amount of the asset to load into the channel (display units, e.g. 100)', required: true },
  ],
  extract: extractBuyAsset,
  confident: (s) => !!s.asset && s.asset_amount !== undefined && Number(s.asset_amount) > 0,
  steps: [
    // 1. Maker prices the asset + the channel.
    //    Returns { rfq_id, btc_amount_sat, channel_fee_sat, total_sat, expires_at }.
    {
      tool: 'kaleidoswap_lsp_quote_asset_channel',
      as: 'quote',
      args: (ctx) => ({ asset: ctx.slots.asset, asset_amount: ctx.slots.asset_amount }),
    },
  ],
  // 2. Order the channel with the fresh rfq_id. Spend → confirmation-gated.
  //    The quote's cost fields ride along so the host's confirm card can show
  //    the price before approval; the create tool treats them as display-only.
  final: {
    tool: 'kaleidoswap_lsp_create_asset_channel',
    args: (ctx) => {
      const q = (ctx.results.quote ?? {}) as {
        rfq_id?: string;
        total_sat?: number;
        btc_amount_sat?: number;
        channel_fee_sat?: number;
        expires_at?: number;
      };
      return {
        asset: ctx.slots.asset,
        asset_amount: ctx.slots.asset_amount,
        rfq_id: q.rfq_id,
        total_sat: q.total_sat,
        btc_amount_sat: q.btc_amount_sat,
        channel_fee_sat: q.channel_fee_sat,
        expires_at: q.expires_at,
      };
    },
  },
  summary: (ctx, finalResult) => {
    const q = ctx.results.quote as { total_sat?: number } | undefined;
    const o = finalResult as { order_id?: string } | undefined;
    const cost = typeof q?.total_sat === 'number' ? ` for ${commas(q.total_sat)} sats` : '';
    const id = o?.order_id ? ` (order ${o.order_id})` : '';
    return `Ordered a Lightning channel with ${ctx.slots.asset_amount} ${ctx.slots.asset}${cost}${id}. Pay the returned invoice/address to open it.`;
  },
};
