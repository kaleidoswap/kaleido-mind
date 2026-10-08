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
  // Portfolio analysis belongs to the portfolio skill, which reads balances
  // and targets before suggesting any action. A mention of "trade" in a review
  // request—especially "do not trade"—must never become an immediate swap.
  if (/\b(portfolio|allocation|holdings|rebalance|rebalancing)\b/i.test(t)) return false;
  if (/\b(?:do\s+not|don't|without|no)\s+(?:place\s+(?:a\s+)?)?(?:trade|swap|buy|sell|trading)\b/i.test(t)) return false;
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
  // kaleido-mcp `kaleidoswap_get_quote` echoes each leg with the resolved
  // asset_id, ticker, layer, the raw integer amount (amount_raw) and a display string.
  from_asset?: { asset_id?: string; ticker?: string; amount_raw?: number; amount_display?: string };
  to_asset?: { asset_id?: string; ticker?: string; amount_raw?: number; amount_display?: string };
  from_amount_display?: string;
  to_amount_display?: string;
  fee_display?: string;
}

// KaleidoSwap atomic is a BTC ↔ RGB venue: BTC settles on Lightning, RGB
// assets on RGB-over-Lightning. The maker/MCP layer is derived from the asset.
const layerFor = (asset: unknown): string =>
  /^btc$/i.test(String(asset)) ? 'BTC_LN' : 'RGB_LN';

/**
 * `kaleidoswap_get_quote` takes display units (0.0005 BTC). The slots carry
 * what the user said: a BTC amount said in sats ("2500 sats") is converted;
 * one said in BTC ("0.001 btc") is kept. Without a unit word, below 1 reads as
 * BTC and 1 or more as sats.
 */
export function quoteAmount(asset: unknown, amount: unknown, text = ''): unknown {
  const n = Number(amount);
  if (!/^(btc|sats?|bitcoin)$/i.test(String(asset ?? '').trim()) || !Number.isFinite(n)) return amount;
  const saidSats = /\b(sats?|satoshis?)\b/i.test(text);
  const saidBtc = /\b(btc|bitcoins?)\b/i.test(text.replace(/\b(sats?|satoshis?)\b/gi, ''));
  const inSats = saidSats || (!saidBtc && n >= 1);
  return inSats ? n / 1e8 : n;
}

/** "swap|convert|exchange|trade|sell <N> <asset> for|to|into <asset>": nothing for a model to resolve. */
const EXPLICIT_SWAP = /\b(?:swap|convert|exchange|trade|sell)\s+\d[\d,]*(?:\.\d+)?\s*(?:sats?|satoshis?|btc|bitcoin|usdt|xaut)\s+(?:for|to|into)\s+(?:sats?|btc|bitcoin|usdt|xaut)\b/i;

/** RLN's minimum HTLC for RGB payments when the node doesn't report one (rgb_htlc_min_msat). */
export const RLN_HTLC_MIN_MSAT = 3_000_000;

type Leg = { asset_id?: string; ticker?: string; layer?: string; amount_raw?: number; amount_display?: string };
type Channel = Record<string, unknown>;

const isBtc = (leg?: Leg) => leg?.layer === 'BTC_LN' || (!leg?.layer && String(leg?.ticker ?? '').toUpperCase() === 'BTC');
const num = (v: unknown): number | undefined => (v == null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
const fmtSats = (msat: number) => `${Math.floor(msat / 1000).toLocaleString('en-US')} sats`;
const legText = (leg?: Leg) => (leg?.amount_display ? `${leg.amount_display}${leg.ticker && !/sats?$/i.test(leg.amount_display) ? ` ${leg.ticker}` : ''}` : (leg?.ticker ?? 'the asset'));

function channelRows(channels: unknown): Channel[] | undefined {
  let list: unknown = channels;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return undefined;
    }
  }
  const rows = Array.isArray(list) ? list : (list as { channels?: unknown })?.channels;
  return Array.isArray(rows) ? (rows as Channel[]) : undefined;
}

/** Largest value of `pick` over usable channels; undefined when no channel reports it. */
function maxOver(rows: Channel[], pick: (c: Channel) => number | undefined): number | undefined {
  let best: number | undefined;
  let readable = false;
  for (const c of rows) {
    const v = pick(c);
    if (v === undefined) continue;
    readable = true;
    if (c.is_usable === false || c.ready === false) continue;
    best = Math.max(best ?? 0, v);
  }
  return best ?? (readable ? 0 : undefined);
}

const outbound = (c: Channel) => num(c.next_outbound_htlc_limit_msat ?? c.outbound_balance_msat);
const inbound = (c: Channel) => num(c.inbound_balance_msat);

/**
 * Why the node can't carry this swap over its Lightning channels, or null when
 * it can (or the channel data doesn't say). RLN sends each leg as one HTLC and
 * adds its RGB HTLC minimum to the BTC side and to the asset payment:
 * - BTC → asset: BTC outbound ≥ amount + minimum; an asset channel with inbound
 *   ≥ the asset received and BTC inbound ≥ minimum.
 * - asset → BTC: an asset channel holding the asset with BTC outbound ≥
 *   minimum; BTC inbound ≥ amount + minimum.
 */
export function swapLiquidityShortfall(
  q: QuoteResult | undefined,
  channels: unknown,
  htlcMinMsat: number = RLN_HTLC_MIN_MSAT,
): string | null {
  const from = q?.from_asset as Leg | undefined;
  const to = q?.to_asset as Leg | undefined;
  const fromBtc = isBtc(from);
  const toBtc = isBtc(to);
  if (fromBtc === toBtc) return null;
  const rows = channelRows(channels);
  if (!rows) return null;
  const min = fmtSats(htlcMinMsat);
  if (!rows.length) return `this swap runs over Lightning and you have no channels. Buy a channel first.`;
  const usable = rows.filter((c) => c.is_usable !== false && c.ready !== false);
  const hasAssetData = rows.some((c) => 'asset_id' in c);
  // Channels name assets by rgb: id; a ticker in the quote can't be matched.
  const assetIdKnown = (leg?: Leg) => hasAssetData && String(leg?.asset_id ?? '').startsWith('rgb:');

  if (fromBtc) {
    const amount = num(from?.amount_raw);
    const maxOut = maxOver(rows, outbound);
    if (amount !== undefined && maxOut !== undefined && maxOut < amount + htlcMinMsat) {
      const need = amount + htlcMinMsat;
      if (maxOut === 0) {
        return `this swap needs a Lightning channel that can send ${fmtSats(need)} (the amount plus the ${min} HTLC minimum), and none can send right now. Buy a channel with at least that much outbound first.`;
      }
      if (maxOut <= htlcMinMsat) {
        return `your channels can send at most ${fmtSats(maxOut)}, which only covers the ${min} HTLC minimum, so no BTC swap fits. This one needs ${fmtSats(need)}: buy a channel with more outbound.`;
      }
      return `your channels can send at most ${fmtSats(maxOut)}, and this swap needs ${fmtSats(need)} (the amount plus the ${min} HTLC minimum). Swap at most ${fmtSats(Math.max(0, maxOut - htlcMinMsat))}, or buy a bigger channel.`;
    }
    const want = num(to?.amount_raw);
    if (assetIdKnown(to) && want !== undefined) {
      const ok = usable.some(
        (c) => c.asset_id === to?.asset_id && (num(c.asset_remote_amount) ?? 0) >= want && (inbound(c) ?? Infinity) >= htlcMinMsat,
      );
      if (!ok) {
        return `no channel can receive ${legText(to)}: you need a ${to?.ticker ?? 'asset'} channel with at least that much inbound and ${min} of BTC inbound. Buy an asset channel from the LSP first.`;
      }
    }
    return null;
  }

  // asset → BTC
  const have = num(from?.amount_raw);
  if (assetIdKnown(from) && have !== undefined) {
    const ok = usable.some(
      (c) => c.asset_id === from?.asset_id && (num(c.asset_local_amount) ?? 0) >= have && (outbound(c) ?? Infinity) >= htlcMinMsat,
    );
    if (!ok) {
      return `no channel can send ${legText(from)}: you need a ${from?.ticker ?? 'asset'} channel holding at least that much, with ${min} of BTC outbound.`;
    }
  }
  const amount = num(to?.amount_raw);
  const maxIn = maxOver(rows, inbound);
  if (amount !== undefined && maxIn !== undefined && maxIn < amount + htlcMinMsat) {
    return `your channels can receive at most ${fmtSats(maxIn)}, and this swap pays you ${fmtSats(amount + htlcMinMsat)} (the amount plus the ${min} HTLC minimum). Swap for less BTC, or get more inbound.`;
  }
  return null;
}

/** @deprecated Use `swapLiquidityShortfall`. */
export const outboundShortfall = swapLiquidityShortfall;

// Render a quote leg as "<amount> <TICKER>". BTC reads in sats from the raw
// msat amount (the maker's display is in BTC, e.g. 0.000025).
const quoteLeg = (leg?: { ticker?: string; layer?: string; amount_raw?: number; amount_display?: string }): string | undefined => {
  if (isBtc(leg) && Number.isFinite(Number(leg?.amount_raw))) return `${Math.floor(Number(leg!.amount_raw) / 1000).toLocaleString('en-US')} sats`;
  return leg?.amount_display != null ? `${leg.amount_display}${leg.ticker ? ` ${leg.ticker}` : ''}` : undefined;
};
interface InitResult { swapstring?: string; payment_hash?: string; atomic_id?: string; access_token?: string }
interface NodeInfo { pubkey?: string }

const FINAL_SWAP_STATUS = new Set(['Succeeded', 'Expired', 'Failed']);

/** The maker's swap status (`{ swap: { status } }`), or undefined. */
function swapStatus(result: unknown): string | undefined {
  let r = result;
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r);
    } catch {
      return undefined;
    }
  }
  const o = r as { swap?: { status?: unknown }; status?: unknown } | undefined;
  const st = o?.swap?.status ?? o?.status;
  return typeof st === 'string' ? st : undefined;
}

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
  // An explicit amount + both assets needs no model, which small models
  // otherwise misread ("2500 sats into USDT" as 2,500 USDT).
  trustExtract: (text) => EXPLICIT_SWAP.test(text),
  confident: (s) => !!s.from_asset && !!s.to_asset && !!s.amount,
  steps: [
    // 1. MAKER quotes the swap (read-only). Returns rfq_id + full asset specs
    //    (echoes the rgb: asset ids and maker-unit amounts) + *_display strings.
    {
      tool: 'kaleidoswap_get_quote',
      as: 'quote',
      args: (ctx) => {
        // 'to' for buy ("buy 1 USDT" → amount is what you RECEIVE) goes on the
        // to_amount leg; 'from' (sell/swap) goes on from_amount. Layers are
        // derived from the asset. Exactly one amount leg is set.
        const side = ctx.slots.amount_side ?? 'from';
        const base = {
          from_asset_id: ctx.slots.from_asset,
          to_asset_id: ctx.slots.to_asset,
          from_layer: layerFor(ctx.slots.from_asset),
          to_layer: layerFor(ctx.slots.to_asset),
        };
        const asset = side === 'to' ? ctx.slots.to_asset : ctx.slots.from_asset;
        const amount = quoteAmount(asset, ctx.slots.amount, ctx.text);
        return side === 'to' ? { ...base, to_amount: amount } : { ...base, from_amount: amount };
      },
    },
    // 1b. NODE: pubkey for execute, and the node's RGB HTLC minimum.
    {
      tool: 'rln_get_node_info',
      as: 'node',
      args: () => ({}),
    },
    // 1c. NODE: can the channels carry both legs? RLN sends each leg as one
    //     HTLC and adds its HTLC minimum. Stop here, before the confirmation,
    //     instead of failing with NoRoute after the maker has locked the swap.
    {
      tool: 'rln_list_channels',
      as: 'channels',
      optional: true,
      args: () => ({}),
      check: (ctx) =>
        swapLiquidityShortfall(
          ctx.results.quote as QuoteResult | undefined,
          ctx.results.channels,
          num((ctx.results.node as { rgb_htlc_min_msat?: unknown } | undefined)?.rgb_htlc_min_msat) ?? RLN_HTLC_MIN_MSAT,
        ),
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
          from_asset_id: q?.from_asset?.asset_id,
          from_amount_raw: q?.from_asset?.amount_raw,
          to_asset_id: q?.to_asset?.asset_id,
          to_amount_raw: q?.to_asset?.amount_raw,
        };
      },
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
  // 6. Follow the swap until the maker reports a final status. The status
  //    needs the per-swap access_token that only init returns.
  poll: {
    tool: 'kaleidoswap_atomic_status',
    as: 'status',
    args: (ctx) => {
      const init = ctx.results.init as InitResult | undefined;
      return { payment_hash: init?.payment_hash, ...(init?.access_token ? { access_token: init.access_token } : {}) };
    },
    done: (result) => FINAL_SWAP_STATUS.has(swapStatus(result) ?? ''),
    intervalMs: 3000,
    timeoutMs: 90_000,
  },
  // ONE confirmation, fired after the quote / before init, with the real numbers.
  confirm: (ctx: RecipeContext) => {
    const q = ctx.results.quote as QuoteResult | undefined;
    const from = quoteLeg(q?.from_asset) ?? `${ctx.slots.amount} ${ctx.slots.from_asset}`;
    const to = quoteLeg(q?.to_asset) ?? String(ctx.slots.to_asset);
    const fee = q?.fee_display ? ` · fee ${q.fee_display}` : '';
    return `Swap ${from} → ${to}${fee} on KaleidoSwap. Proceed?`;
  },
  summary: (ctx) => {
    const q = ctx.results.quote as QuoteResult | undefined;
    const from = quoteLeg(q?.from_asset) ?? `${ctx.slots.amount} ${ctx.slots.from_asset}`;
    const to = quoteLeg(q?.to_asset) ?? String(ctx.slots.to_asset);
    const init = ctx.results.init as InitResult | undefined;
    const hash = init?.payment_hash || init?.atomic_id || '?';
    const token = init?.access_token ? `, access_token=${init.access_token}` : '';
    const status = swapStatus(ctx.results.status);
    if (status === 'Succeeded') return `Swap completed: you sent ${from} and received ${to}.`;
    if (status === 'Expired' || status === 'Failed') return `The swap ${status.toLowerCase()}: ${from} → ${to} did not complete, and nothing was exchanged.`;
    return `remember: atomic swap payment_hash=${hash}${token} (for kaleidoswap_atomic_status checks).
Swap submitted: ${from} → ${to}, status ${status ?? 'unknown'}. Check it with kaleidoswap_atomic_status(payment_hash=${hash}${token}), or say "check my swap status".`;
  },
};
