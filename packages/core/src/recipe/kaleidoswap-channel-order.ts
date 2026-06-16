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
 * Fire on inbound-liquidity / channel-order intent. Excludes:
 *   - explanatory / educational questions ("why do I need a channel?", "what
 *     is a channel?") — those go to RAG-backed agentic answering.
 *   - the trading skill's territory.
 */
function CHANNEL_INTENT(t: string): boolean {
  // Explanatory/question phrasing → not an order, let the agentic path handle it.
  if (/\b(why|how|what|when|explain|tell\s+me|do\s+I\s+need|should\s+I|can\s+I)\b/i.test(t)) return false;
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

  // Count standalone numeric tokens. Two-or-more numbers (e.g.
  // "20000 my side 80000 lsp") are ambiguous to the regex — bail out and
  // let the LLM disambiguate; the Funnel still fires the recipe via
  // forceModelExtract + match().
  const numberTokens = t.match(/\b\d[\d,.]*\s*(?:k|m|million)?\b/gi) ?? [];
  const multipleNumbers = numberTokens.length >= 2;

  // Expiry in days/months/blocks → blocks (10 min ≈ 1 block). Safe to parse
  // independently of the balance numbers because the unit token disambiguates.
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

  // Side-tagged amounts. We try KEYWORD-FIRST patterns ("on my side 5000",
  // "lsp_balance 100000") before NUMBER-FIRST ("5000 on my side", "100k on lsp"),
  // because "5000 lsp_balance 100000" is ambiguous to number-first regexes.
  let client_balance_sat: number | undefined;
  let lsp_balance_sat: number | undefined;

  // NUMBER then KEYWORD — directional phrases ("X on my side", "X on lsp",
  // "X sats my side"). The (?:sats?\s+)? lets the user say the unit between
  // the number and the side keyword: "100k sats my side" → 100000.
  const clientNum = t.match(/\b(\d[\d,.]*)\s*(k|m)?\s+(?:sats?\s+)?(?:on\s+(?:my|client|user)\s+side|on\s+my\b|on\s+mine\b|on\s+client|my\s+side|mine\b|as\s+push|push|outbound)\b/i);
  if (clientNum && clientNum[1]) client_balance_sat = parseAmountWord(clientNum[1], clientNum[2]);

  const lspNum = t.match(/\b(\d[\d,.]*)\s*(k|m)?\s+(?:sats?\s+)?(?:on\s+(?:the\s+)?lsp|for\s+(?:the\s+)?lsp|as\s+inbound|inbound|lsp[_\s]+side)\b/i);
  if (lspNum && lspNum[1]) lsp_balance_sat = parseAmountWord(lspNum[1], lspNum[2]);

  // KEYWORD then NUMBER — programmatic phrasings ("client_balance 5000",
  // "lsp_balance 100000", "with 10k push"). Skip "my side" / "on lsp" here
  // — those are number-first in real English (handled above).
  if (client_balance_sat == null) {
    const clientKw = t.match(/(?:client[_\s]+balance|push\s+of|outbound\s+of|with\s+(\d[\d,.]*)\s*(k|m)?\s+push)\s*(?:of\s+)?(\d[\d,.]*)?\s*(k|m)?\b/i);
    if (clientKw) {
      // Either "with N push" (groups 1+2) or "client_balance N" (groups 3+4).
      const num = clientKw[1] ?? clientKw[3];
      const suf = clientKw[1] ? clientKw[2] : clientKw[4];
      if (num) client_balance_sat = parseAmountWord(num, suf);
    }
  }
  if (lsp_balance_sat == null) {
    const lspKw = t.match(/(?:lsp[_\s]+balance|lsp[_\s]+side|inbound\s+capacity|inbound\s+of)\s*(?:of\s+)?(\d[\d,.]*)\s*(k|m)?\b/i);
    if (lspKw && lspKw[1]) lsp_balance_sat = parseAmountWord(lspKw[1], lspKw[2]);
  }

  // SINGLE-amount default: if there's only one number and we couldn't tag it
  // as client/lsp by phrasing, treat it as lsp_balance_sat (the user is
  // asking for inbound liquidity). With multiple numbers and no disambiguating
  // phrasing, return null and let the LLM sort it out.
  if (!lsp_balance_sat && !multipleNumbers) {
    const m = t.match(/\b(\d[\d,.]*)\s*(k|m|million)?\b/i);
    if (m && m[1]) lsp_balance_sat = parseAmountWord(m[1], m[2]);
  }

  // RGB asset channel: a ticker (USDT/XAUT) plus an asset amount.
  // We don't resolve the ticker → asset_id here — that happens deterministically
  // from lsp_get_info during the recipe. We just record what the user said.
  let asset_ticker: string | undefined;
  const tickerMatch = t.match(/\b(usdt|tether|xaut|gold)\b/i);
  if (tickerMatch) {
    const x = tickerMatch[1]!.toLowerCase();
    asset_ticker = /usdt|tether/.test(x) ? 'USDT' : 'XAUT';
  }

  let lsp_asset_amount: number | undefined;
  let client_asset_amount: number | undefined;
  // Asset amount keywords. "N USDT" alone is ambiguous; with side keywords
  // we can disambiguate: "N USDT inbound" / "N USDT lsp side" → lsp side;
  // "N USDT my side" / "N USDT pushed" / "pushed N USDT" → client side.
  if (asset_ticker) {
    // CLIENT-side asset (push)
    const pushAssetNum = t.match(/\b(\d[\d,.]*)\s+(?:usdt|tether|xaut|gold)\s+(?:on\s+my\s+side|on\s+(?:my|client|user)\s+side|my\s+side|pushed?(?:\s+to\s+(?:my|client)\s+side)?)\b/i);
    if (pushAssetNum && pushAssetNum[1]) client_asset_amount = parseAmountWord(pushAssetNum[1]);
    const pushAssetKw = t.match(/\bpush(?:ed)?\s+(\d[\d,.]*)\s*(?:usdt|tether|xaut|gold)\b/i);
    if (client_asset_amount == null && pushAssetKw && pushAssetKw[1]) client_asset_amount = parseAmountWord(pushAssetKw[1]);

    // LSP-side asset (inbound)
    const lspAssetNum = t.match(/\b(\d[\d,.]*)\s+(?:usdt|tether|xaut|gold)\s+(?:inbound|on\s+(?:the\s+)?lsp(?:\s+side)?|for\s+(?:the\s+)?lsp|lsp[_\s]+side)\b/i);
    if (lspAssetNum && lspAssetNum[1]) lsp_asset_amount = parseAmountWord(lspAssetNum[1]);

    // Default: a single "N USDT" without a side keyword → lsp side (the
    // inbound ask). Skip if we already captured client_asset_amount and the
    // SAME number could be the user-side amount.
    if (lsp_asset_amount == null) {
      const allAssetMatches = t.match(/\b\d[\d,.]*\s*(?:usdt|tether|xaut|gold)\b/gi) ?? [];
      const ambiguous = allAssetMatches.length > 1;
      if (!ambiguous) {
        const am = t.match(/\b(\d[\d,.]*)\s*(?:usdt|tether|xaut|gold)\b/i);
        if (am && am[1]) lsp_asset_amount = parseAmountWord(am[1]);
      }
    }
  }

  const out: Record<string, unknown> = {};
  if (lsp_balance_sat != null) out.lsp_balance_sat = lsp_balance_sat;
  if (client_balance_sat != null) out.client_balance_sat = client_balance_sat;
  if (channel_expiry_blocks != null) out.channel_expiry_blocks = channel_expiry_blocks;
  if (asset_ticker != null) out.asset_ticker = asset_ticker;
  if (lsp_asset_amount != null) out.lsp_asset_amount = lsp_asset_amount;
  if (client_asset_amount != null) out.client_asset_amount = client_asset_amount;
  // Return null when no concrete fields were extracted — the Funnel still
  // fires the recipe because forceModelExtract + match() carry the intent.
  // The runner's LLM extraction populates slots; if even the LLM can't
  // produce lsp_balance_sat, runRecipe returns status:'needs-info'.
  return Object.keys(out).length > 0 ? out : null;
}

interface LspAsset {
  asset_id?: string;
  ticker?: string;
  name?: string;
  precision?: number;
  min_initial_lsp_amount?: number;
  max_initial_lsp_amount?: number;
}
interface LspInfo {
  lsp_connection_url?: string;
  options?: {
    min_initial_lsp_balance_sat?: number;
    max_initial_lsp_balance_sat?: number;
    max_channel_expiry_blocks?: number;
  };
  assets?: LspAsset[];
}

/** Find the LSP's record for a ticker (USDT, XAUT). Case-insensitive. */
function findAsset(info: LspInfo | undefined, ticker: string | undefined): LspAsset | undefined {
  if (!info?.assets || !ticker) return undefined;
  const t = ticker.toUpperCase();
  return info.assets.find((a) => (a.ticker ?? '').toUpperCase() === t);
}

/** "100" USDT (precision 6) → 100_000_000 micro-USDT. */
function scaleAsset(amount: number | undefined, precision: number | undefined): number | undefined {
  if (amount == null) return undefined;
  const p = Number(precision ?? 0);
  return Math.round(amount * Math.pow(10, p));
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
  // The maker echoes the capacities it ACCEPTED — may differ from what was
  // requested (e.g. it can zero client_balance_sat). Used for verification.
  lsp_balance_sat?: number;
  client_balance_sat?: number;
  asset_id?: string;
  lsp_asset_amount?: number;
  client_asset_amount?: number;
  payment?: {
    bolt11?: {
      invoice?: string;
      order_total_sat?: number;
      fee_total_sat?: number;
    };
  };
}
interface ChannelRow {
  channel_id?: string;
  capacity_sat?: number;
  inbound_sat?: number;
  outbound_sat?: number;
  asset_id?: string;
  asset_local_amount?: number;
  asset_remote_amount?: number;
  ready?: boolean;
  status?: string;
}
interface ChannelsResult { channels?: ChannelRow[]; count?: number }

export const kaleidoswapChannelOrderRecipe: Recipe = {
  name: 'kaleidoswap-channel-order',
  description:
    "Buy inbound Lightning channel capacity from the LSP via LSPS1: check options, estimate fees, fetch the user's pubkey, confirm once, create the order and pay the LSP invoice.",
  match: (t) => CHANNEL_INTENT(t),
  triggers: ['inbound', 'liquidity', 'channel order', 'lsps1', 'lsp', 'open channel'],
  slots: [
    {
      name: 'lsp_balance_sat',
      type: 'number',
      description:
        "Sats the LSP commits on THEIR side — the inbound capacity for the user. " +
        "Phrasings: 'inbound', 'lsp side', 'their side', 'on lsp', 'X for lsp', 'lsp balance'. " +
        "Example: in 'buy a channel, 20000 my side, 80000 on lsp', lsp_balance_sat = 80000.",
      required: true,
    },
    {
      name: 'client_balance_sat',
      type: 'number',
      description:
        "Sats the user PRE-FUNDS into the channel (push amount). 0 by default. " +
        "Phrasings: 'my side', 'client side', 'outbound', 'push', 'I put in', 'X on my side'. " +
        "Example: in 'buy a channel, 20000 my side, 80000 on lsp', client_balance_sat = 20000.",
    },
    {
      name: 'channel_expiry_blocks',
      type: 'number',
      description:
        "Lease duration in blocks (10 min per block). Default 4320 (~30 days). " +
        "Map natural language: '1 month' → 4320, '1 week' → 1008, 'N days' → N*144.",
    },
    {
      name: 'asset_ticker',
      type: 'string',
      description:
        "RGB asset ticker for an asset channel (USDT or XAUT). Omit for a plain BTC channel. " +
        "Recognise: 'USDT channel', 'a USDT channel', 'channel with USDT', 'Tether' → USDT; " +
        "'gold', 'XAUT' → XAUT.",
    },
    {
      name: 'lsp_asset_amount',
      type: 'number',
      description:
        "Asset units the LSP commits on their side. UNITS, not micro-units (the host scales " +
        "by the asset's precision). Example: '100 USDT' → lsp_asset_amount = 100. " +
        "Only set when the user is buying an asset channel.",
    },
    {
      name: 'client_asset_amount',
      type: 'number',
      description:
        "Asset units the LSP pushes to the USER's side at channel open (costs sats at the " +
        "current swap rate). UNITS, not micro-units. Default 0. Only set if the user wants " +
        "spendable asset balance immediately, not just inbound capacity. Requires rfq_id.",
    },
    {
      name: 'rfq_id',
      type: 'string',
      description:
        "Quote id from a prior kaleidoswap_get_quote — required only when client_asset_amount > 0 " +
        "so the LSP can price the asset push at a fixed rate. Omit otherwise.",
    },
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
    // 2. Fee estimate for the requested size. For asset channels, the maker's
    //    estimate_fees doesn't yet take asset_id (per the integration test
    //    body) — the asset spec is on the create_order body. Estimate the
    //    sats portion; the asset side is provisioned LSP-server-side.
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
    // 3a. Snapshot existing channels so we can identify the NEW one after the
    //     order opens (diff by channel_id). Without this, verification can't
    //     tell the freshly-opened channel from pre-existing ones.
    {
      tool: 'rln_list_channels',
      as: 'channels_before',
      args: () => ({}),
    },
    // 3b. Asset push leg: when client_asset_amount > 0, the maker requires
    //     a fresh rfq_id from kaleidoswap_get_quote(BTC → asset) so the LSP
    //     can lock the BTC price for the asset push. The maker's RFQ ↔
    //     order asset-id check is strict, so pass the FULL rgb: URI (not
    //     the ticker) as to_asset, matching what create_order will send.
    //     Skip when there's no push asset.
    {
      tool: 'kaleidoswap_get_quote',
      as: 'asset_quote',
      args: (ctx) => {
        const info = ctx.results.info as LspInfo | undefined;
        const ticker = ctx.slots.asset_ticker ? String(ctx.slots.asset_ticker) : undefined;
        const asset = findAsset(info, ticker);
        return {
          from_asset: 'BTC',
          to_asset: asset?.asset_id ?? ticker ?? 'USDT',
          amount: scaleAsset(Number(ctx.slots.client_asset_amount ?? 0), asset?.precision),
          amount_side: 'to',
        };
      },
      skipIf: (ctx) => Number(ctx.slots.client_asset_amount ?? 0) <= 0,
    },
    // 4. Create the order. Spend → this is where the single confirm gate
    //    fires. For asset channels we resolve the ticker → asset_id from
    //    lsp_get_info.assets, and scale the agent-facing unit amount by the
    //    asset's precision (USDT precision=6 → ×1e6).
    {
      tool: 'lsp_create_order',
      as: 'order',
      args: (ctx) => {
        const node = ctx.results.node as NodeInfo | undefined;
        const info = ctx.results.info as LspInfo | undefined;
        const tickerSlot = ctx.slots.asset_ticker ? String(ctx.slots.asset_ticker) : undefined;
        const asset = findAsset(info, tickerSlot);
        const body: Record<string, unknown> = {
          client_pubkey: node?.pubkey,
          lsp_balance_sat: Number(ctx.slots.lsp_balance_sat),
          client_balance_sat: Number(ctx.slots.client_balance_sat ?? 0),
          channel_expiry_blocks: Number(ctx.slots.channel_expiry_blocks ?? DEFAULT_EXPIRY_BLOCKS),
        };
        if (asset?.asset_id && (ctx.slots.lsp_asset_amount != null || ctx.slots.client_asset_amount != null)) {
          body.asset_id = asset.asset_id;
          const lspAmt = scaleAsset(Number(ctx.slots.lsp_asset_amount ?? 0), asset.precision);
          const cliAmt = scaleAsset(Number(ctx.slots.client_asset_amount ?? 0), asset.precision);
          if (lspAmt != null) body.lsp_asset_amount = lspAmt;
          if (cliAmt != null) body.client_asset_amount = cliAmt;
          // client_asset_amount > 0 requires an rfq_id from a BTC→asset quote.
          // Auto-sourced from step 3b above; falls back to a user-supplied
          // slot if step 3b was skipped or didn't return one.
          const autoQuote = ctx.results.asset_quote as { rfq_id?: string } | undefined;
          const rfq = autoQuote?.rfq_id ?? (ctx.slots.rfq_id != null ? String(ctx.slots.rfq_id) : undefined);
          if (rfq) body.rfq_id = rfq;
        }
        return body;
      },
    },
    // 5. Pay the LSP's Lightning invoice. Spend, but no second prompt — the
    //    single recipe-level confirm covered the decision to commit funds.
    {
      tool: 'rln_pay_invoice',
      as: 'paid',
      args: (ctx) => {
        const order = ctx.results.order as OrderResult | undefined;
        return { invoice: order?.payment?.bolt11?.invoice };
      },
    },
  ],
  // 6. VERIFY: list the node's channels so we can compare the requested
  //    capacity against what actually opened. Read-only, so no gate. On
  //    regtest the channel funds within seconds; on slower nets it may not
  //    be visible yet — the summary reports either way.
  final: {
    tool: 'rln_list_channels',
    as: 'channels',
    args: () => ({}),
  },
  // ONE confirmation, fired after estimate_fees + get_node_info, before
  // lsp_create_order. Shows the real total fee + BOTH sides of the channel.
  confirm: (ctx: RecipeContext) => {
    const fees = ctx.results.fees as FeesResult | undefined;
    const inbound = Number(ctx.slots.lsp_balance_sat);
    const mine = Number(ctx.slots.client_balance_sat ?? 0);
    const expiry = Number(ctx.slots.channel_expiry_blocks ?? DEFAULT_EXPIRY_BLOCKS);
    const days = Math.round(expiry / 144);
    const feeStr = fees?.total_fee != null ? ` for ${fees.total_fee.toLocaleString()} sats` : '';
    const minePart = mine > 0 ? ` + ${mine.toLocaleString()} sats on your side` : '';
    const ticker = ctx.slots.asset_ticker ? String(ctx.slots.asset_ticker) : undefined;
    const lspAsset = Number(ctx.slots.lsp_asset_amount ?? 0);
    const cliAsset = Number(ctx.slots.client_asset_amount ?? 0);
    const assetPart = ticker
      ? ` + ${lspAsset.toLocaleString()} ${ticker} inbound${cliAsset > 0 ? ` and ${cliAsset.toLocaleString()} ${ticker} on your side` : ''}`
      : '';
    return `Buy a channel: ${inbound.toLocaleString()} sats inbound${minePart}${assetPart} from the LSP (~${days} days)${feeStr}. Proceed?`;
  },
  summary: (ctx) => {
    const order = ctx.results.order as OrderResult | undefined;
    const channels = ctx.results.channels as ChannelsResult | undefined;
    const id = order?.order_id ?? '?';
    const token = order?.access_token;
    const tokenNote = token ? ` (access token: ${token} — save it for status checks)` : '';
    const total = order?.payment?.bolt11?.order_total_sat;
    const paid = total != null ? `, paid ${total.toLocaleString()} sats` : '';

    // VERIFY requested vs accepted (the maker echoes what it actually took).
    const reqInbound = Number(ctx.slots.lsp_balance_sat);
    const reqMine = Number(ctx.slots.client_balance_sat ?? 0);
    const gotInbound = order?.lsp_balance_sat;
    const gotMine = order?.client_balance_sat;
    const mismatches: string[] = [];
    if (gotInbound != null && gotInbound !== reqInbound) {
      mismatches.push(`inbound ${reqInbound.toLocaleString()}→${gotInbound.toLocaleString()} sats`);
    }
    if (gotMine != null && gotMine !== reqMine) {
      mismatches.push(`your side ${reqMine.toLocaleString()}→${gotMine.toLocaleString()} sats`);
    }
    const adjusted = mismatches.length
      ? ` ⚠ the LSP adjusted: ${mismatches.join(', ')}.`
      : '';

    // VERIFY against the freshly-opened channel — identified by DIFF against
    // the pre-order snapshot, so we never mistake a pre-existing channel for
    // the new one.
    const before = ctx.results.channels_before as ChannelsResult | undefined;
    const beforeIds = new Set((before?.channels ?? []).map((c) => c.channel_id));
    const fresh = (channels?.channels ?? []).filter((c) => c.channel_id && !beforeIds.has(c.channel_id));
    const match = fresh[0];
    let opened = ' The channel will open once the LSP confirms the payment — ask me to check its status (use the access token above with lsp_get_order).';
    if (match) {
      const cap = match.capacity_sat != null ? `${match.capacity_sat.toLocaleString()}-sat` : 'new';
      const ready = match.ready ? 'ready' : (match.status ?? 'opening');
      const inb = match.inbound_sat != null ? `, ${match.inbound_sat.toLocaleString()} sats inbound` : '';
      opened = ` New channel ${cap} is open (${ready})${inb}.`;
    }

    const ticker = ctx.slots.asset_ticker ? String(ctx.slots.asset_ticker) : undefined;
    const lspAsset = Number(ctx.slots.lsp_asset_amount ?? 0);
    const assetPart = ticker ? ` (${lspAsset.toLocaleString()} ${ticker} inbound)` : '';

    return `Channel order ${id}${tokenNote} created${paid}${assetPart}.${adjusted}${opened}`;
  },
};
