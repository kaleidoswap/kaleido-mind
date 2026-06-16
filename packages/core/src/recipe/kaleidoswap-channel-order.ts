/**
 * Built-in "buy inbound channel capacity from the LSP" recipe (LSPS1).
 *
 *   "buy a 500k inbound channel"
 *   "I need 200000 sats of inbound liquidity"
 *   "open a channel from the LSP, 1M inbound for 30 days"
 *     ↓ heuristic pre-filter (0 inf) decides to enter the recipe branch
 *     ↓ 1 model inference (forced LLM slot extraction)
 *   lsp_get_info             ← LSP   options + assets (read-only)
 *   lsp_estimate_fees        ← LSP   fee preview     (read-only)
 *   rln_get_node_info        ← NODE  client_pubkey   (read-only)
 *     ↓ [ONE confirmation gate — shows estimated total fee + channel terms]
 *   lsp_create_order         ← LSP   creates the order → bolt11 invoice
 *   rln_pay_invoice          ← NODE  pays the LSP invoice → channel opens
 *
 * Mirrors the single-confirm pattern from kaleidoswapAtomicRecipe: the user
 * decides ONCE on the fee, then create_order + pay_invoice run as one
 * approved unit. The channel's actual opening is asynchronous — the recipe
 * reports "order placed and paid, channel opening" and leaves polling to a
 * follow-up turn (lsp_get_order) so the chat isn't blocked.
 *
 * forceModelExtract: a small model can't reliably regex out a fuzzy phrasing
 * like "I want a channel from the LSP, 500k inbound for a month, no push" —
 * so the recipe still owns the chain + the single confirm, but lets the LLM
 * do the natural-language understanding for slot extraction.
 */

import type { Recipe, RecipeContext } from './types.js';

/** Default expiry: ~30 days at 10-min blocks. The recipe surfaces this in confirm. */
const DEFAULT_EXPIRY_BLOCKS = 4320;

/**
 * Fire on inbound-liquidity / channel-order intent. Excludes generic Lightning
 * questions ("what's a channel?") and the trading skill's territory.
 */
function CHANNEL_INTENT(t: string): boolean {
  // Explicit LSPS1 keywords always match.
  if (/\b(lsps1|lsp\s+order|channel\s+order)\b/i.test(t)) return true;
  // Inbound liquidity asks.
  if (/\binbound(\s+(liquidity|capacity|channel))?\b/i.test(t)) return true;
  if (/\bcan('?t| not)\s+receive\b/i.test(t)) return true;
  // "Buy / open / get a channel from the LSP" (or just "from KaleidoSwap"
  // when the keyword "channel" is present).
  if (/\b(buy|open|get|order)\b.*\bchannel\b/i.test(t)) return true;
  return false;
}

const SATS_RE =
  /\b([0-9][\d,.]*)\s*(k|m|million|million sats?)?\s*(sats?|satoshis?|inbound|channel)?\b/i;

/** "500k" → 500000; "1m" → 1_000_000; "200,000" → 200000. */
function parseAmountWord(num: string, suffix?: string): number | undefined {
  const n = Number(num.replace(/,/g, ''));
  if (!Number.isFinite(n)) return undefined;
  if (!suffix) return Math.round(n);
  const s = suffix.toLowerCase();
  if (/^k/.test(s)) return Math.round(n * 1_000);
  if (/^m/.test(s)) return Math.round(n * 1_000_000);
  return Math.round(n);
}

/**
 * Deterministic extractor — fast pre-filter for the Funnel to decide whether
 * to enter the recipe branch. The model still runs (forceModelExtract) for
 * the slots actually used in execution.
 */
export function extractChannelOrder(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!CHANNEL_INTENT(t)) return null;

  // Inbound capacity — look for the first number with sats/k/m near a
  // channel-ish keyword.
  let lsp_balance_sat: number | undefined;
  const m = t.match(SATS_RE);
  if (m && m[1]) lsp_balance_sat = parseAmountWord(m[1], m[2]);

  // Expiry in days/months/blocks → blocks (10 min ≈ 1 block).
  let channel_expiry_blocks: number | undefined;
  const exp = t.match(/(\d+)\s*(day|days|week|weeks|month|months|block|blocks)\b/i);
  if (exp) {
    const n = Number(exp[1]);
    const unit = exp[2]!.toLowerCase();
    if (/block/.test(unit)) channel_expiry_blocks = n;
    else if (/day/.test(unit)) channel_expiry_blocks = n * 144;
    else if (/week/.test(unit)) channel_expiry_blocks = n * 144 * 7;
    else if (/month/.test(unit)) channel_expiry_blocks = n * 144 * 30;
  }

  // Push amount ("with 10k push" / "client balance 5000").
  let client_balance_sat: number | undefined;
  const push = t.match(/(?:push|client\s+balance|outbound)\s*(?:of\s+)?(\d[\d,.]*)\s*(k|m)?/i);
  if (push && push[1]) client_balance_sat = parseAmountWord(push[1], push[2]);

  const out: Record<string, unknown> = {};
  if (lsp_balance_sat != null) out.lsp_balance_sat = lsp_balance_sat;
  if (client_balance_sat != null) out.client_balance_sat = client_balance_sat;
  if (channel_expiry_blocks != null) out.channel_expiry_blocks = channel_expiry_blocks;
  // Return null when no concrete fields were extracted — the Funnel still
  // fires the recipe because forceModelExtract + match() carry the intent.
  // The runner's LLM extraction will populate slots; if even the LLM can't
  // produce lsp_balance_sat, runRecipe returns status:'needs-info'.
  return Object.keys(out).length > 0 ? out : null;
}

interface LspInfo {
  lsp_connection_url?: string;
  options?: {
    min_initial_lsp_balance_sat?: number;
    max_initial_lsp_balance_sat?: number;
    max_channel_expiry_blocks?: number;
  };
}
interface FeesResult {
  setup_fee?: number;
  capacity_fee?: number;
  duration_fee?: number;
  total_fee?: number;
}
interface NodeInfo { pubkey?: string }
interface OrderResult {
  order_id?: string;
  access_token?: string;
  order_state?: string;
  payment?: {
    bolt11?: {
      invoice?: string;
      order_total_sat?: number;
      fee_total_sat?: number;
    };
  };
}

export const kaleidoswapChannelOrderRecipe: Recipe = {
  name: 'kaleidoswap-channel-order',
  description:
    "Buy inbound Lightning channel capacity from the LSP via LSPS1: check options, estimate fees, fetch the user's pubkey, confirm once, create the order and pay the LSP invoice.",
  match: (t) => CHANNEL_INTENT(t),
  triggers: ['inbound', 'liquidity', 'channel order', 'lsps1', 'lsp', 'open channel'],
  slots: [
    { name: 'lsp_balance_sat', type: 'number', description: 'Sats the LSP commits on their side (the inbound capacity for the user)', required: true },
    { name: 'client_balance_sat', type: 'number', description: 'Sats the user pre-funds (push amount). Default 0.' },
    { name: 'channel_expiry_blocks', type: 'number', description: 'Lease duration in blocks. Default 4320 (~30 days).' },
  ],
  extract: extractChannelOrder,
  forceModelExtract: true,
  confident: (s) => Number(s.lsp_balance_sat) > 0,
  steps: [
    // 1. LSP options (limits + node URI). Read-only.
    {
      tool: 'lsp_get_info',
      as: 'info',
      args: () => ({}),
    },
    // 2. Fee estimate for the requested size.
    {
      tool: 'lsp_estimate_fees',
      as: 'fees',
      args: (ctx) => ({
        lsp_balance_sat: Number(ctx.slots.lsp_balance_sat),
        client_balance_sat: Number(ctx.slots.client_balance_sat ?? 0),
        channel_expiry_blocks: Number(ctx.slots.channel_expiry_blocks ?? DEFAULT_EXPIRY_BLOCKS),
      }),
    },
    // 3. User's node pubkey — needed for create_order. Deterministic.
    {
      tool: 'rln_get_node_info',
      as: 'node',
      args: () => ({}),
    },
    // 4. Create the order. Spend → this is where the single confirm gate fires.
    {
      tool: 'lsp_create_order',
      as: 'order',
      args: (ctx) => {
        const node = ctx.results.node as NodeInfo | undefined;
        return {
          client_pubkey: node?.pubkey,
          lsp_balance_sat: Number(ctx.slots.lsp_balance_sat),
          client_balance_sat: Number(ctx.slots.client_balance_sat ?? 0),
          channel_expiry_blocks: Number(ctx.slots.channel_expiry_blocks ?? DEFAULT_EXPIRY_BLOCKS),
        };
      },
    },
  ],
  // 5. Pay the LSP's Lightning invoice. Spend, but no second prompt — the
  //    single recipe-level confirm covered the decision to commit funds.
  final: {
    tool: 'rln_pay_invoice',
    args: (ctx) => {
      const order = ctx.results.order as OrderResult | undefined;
      return { invoice: order?.payment?.bolt11?.invoice };
    },
  },
  // ONE confirmation, fired after estimate_fees + get_node_info, before
  // lsp_create_order. Shows the real total fee from the maker.
  confirm: (ctx: RecipeContext) => {
    const fees = ctx.results.fees as FeesResult | undefined;
    const inbound = Number(ctx.slots.lsp_balance_sat);
    const expiry = Number(ctx.slots.channel_expiry_blocks ?? DEFAULT_EXPIRY_BLOCKS);
    const days = Math.round(expiry / 144);
    const feeStr = fees?.total_fee != null ? ` for ${fees.total_fee.toLocaleString()} sats` : '';
    return `Buy a ${inbound.toLocaleString()}-sat inbound channel from the LSP (~${days} days)${feeStr}. Proceed?`;
  },
  summary: (ctx) => {
    const order = ctx.results.order as OrderResult | undefined;
    const inbound = Number(ctx.slots.lsp_balance_sat);
    const id = order?.order_id ?? '?';
    const total = order?.payment?.bolt11?.order_total_sat;
    const paid = total != null ? `, paid ${total.toLocaleString()} sats` : '';
    return `Channel order ${id} created${paid}. The channel will open once the LSP confirms the payment — ask "what's the status of my channel order?" to check.`;
  },
};
