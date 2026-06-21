/**
 * Built-in "swap" recipe — quote → (confirm) → execute, over the contract tools.
 *
 *   "buy 0.001 btc with usdt"   → from USDT, to BTC
 *   "swap 10 usdt for btc"      → from USDT, to BTC
 *   "sell 100 usdt for sats"    → from USDT, to BTC
 *
 * The deterministic extractor handles the common phrasings; the runner falls
 * back to one LLM extraction otherwise. execute_swap is a spend → the engine's
 * confirmation gate fires before it runs.
 */

import type { Recipe } from './types.js';

const ASSET = /\b(btc|bitcoin|sats?|usdt|tether|xaut|gold)\b/i;

/** Strict: returns a canonical code only for a KNOWN crypto asset, else undefined
 *  (so "kaleido", "the", etc. are not mistaken for an asset). */
function knownAsset(a?: string): string | undefined {
  if (!a) return undefined;
  const x = a.toLowerCase();
  if (/^(btc|bitcoin|sat|sats|satoshi|satoshis)$/.test(x)) return 'BTC';
  if (/^(usdt|tether)$/.test(x)) return 'USDT';
  if (/^(xaut|gold)$/.test(x)) return 'XAUT';
  return undefined;
}

// Small word-numbers cover the common spoken/typed cases ("buy one usdt").
const WORD_NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const AMT = '([\\d.,]+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)';

function parseAmount(s?: string): number | undefined {
  if (!s) return undefined;
  const t = s.trim().toLowerCase();
  if (t in WORD_NUM) return WORD_NUM[t];
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse a swap/buy/sell request into { from_asset, to_asset, amount, amount_side }.
 *
 * `amount_side` says which leg the amount belongs to (the maker takes the amount
 * on exactly one leg):
 *   - "buy N X"     → receive N of X  → amount on the TO leg, from defaults to BTC
 *   - "sell N X"    → spend N of X    → amount on the FROM leg, to defaults to BTC
 *   - "swap N X to Y" → spend N of X  → amount on the FROM leg
 *
 *   "buy one usdt"            → from BTC, to USDT, amount 1 on `to`
 *   "buy 0.001 btc with usdt" → from USDT, to BTC,  amount 0.001 on `to`
 *   "sell 100 usdt"           → from USDT, to BTC,  amount 100 on `from`
 *   "swap 10 usdt for btc"    → from USDT, to BTC,  amount 10 on `from`
 */
export function extractSwap(text: string): Record<string, unknown> | null {
  const t = text.trim();
  let m: RegExpMatchArray | null;

  // buy/get/purchase <amt> <asset> [with/using/from <funding-asset>]
  // amount is of the asset being BOUGHT → it sits on the TO leg.
  if ((m = t.match(new RegExp(`\\b(?:buy|get|purchase|acquire)\\s+${AMT}\\s*([a-z]+)(?:\\s+(?:with|using|from|for)\\s+([a-z]+))?`, 'i')))) {
    const to = knownAsset(m[2]);
    if (to) {
      const from = knownAsset(m[3]) ?? (to === 'BTC' ? 'USDT' : 'BTC');
      return { amount: parseAmount(m[1]), from_asset: from, to_asset: to, amount_side: 'to' };
    }
  }

  // sell <amt> <asset> [for/to/into <target>]
  // amount is of the asset being SOLD → it sits on the FROM leg.
  if ((m = t.match(new RegExp(`\\bsell\\s+${AMT}\\s*([a-z]+)(?:\\s+(?:for|to|into)\\s+([a-z]+))?`, 'i')))) {
    const from = knownAsset(m[2]);
    if (from) {
      const to = knownAsset(m[3]) ?? (from === 'BTC' ? 'USDT' : 'BTC');
      return { amount: parseAmount(m[1]), from_asset: from, to_asset: to, amount_side: 'from' };
    }
  }

  // swap/convert/exchange/trade <amt> <from> for/to/into <to>
  if ((m = t.match(new RegExp(`\\b(?:swap|convert|exchange|trade)\\s+${AMT}\\s*([a-z]+)\\s+(?:for|to|into)\\s+([a-z]+)`, 'i')))) {
    const from = knownAsset(m[2]);
    const to = knownAsset(m[3]);
    if (from && to) return { amount: parseAmount(m[1]), from_asset: from, to_asset: to, amount_side: 'from' };
  }

  // Price/rate questions are NOT swaps — they belong to extractPriceQuery +
  // kaleidoswapPriceRecipe (read-only). Don't gobble them here.
  return null;
}

/**
 * Parse a PRICE / rate / "how much" question — read-only intent.
 *
 * Distinct from extractSwap: never returns slots for swap/buy/sell phrasings.
 * Always `amount: 1` on the asked-about asset (TO leg). Used by
 * `kaleidoswapPriceRecipe` to fire a quote without moving funds.
 *
 *   "what is the price of usdt in sats"  → {from: BTC,  to: USDT, amount: 1, side: 'to'}
 *   "btc price"                          → {from: USDT, to: BTC,  amount: 1, side: 'to'}
 *   "how much sats for 1 usdt"           → {from: BTC,  to: USDT, amount: 1, side: 'to'}
 */
export function extractPriceQuery(text: string): Record<string, unknown> | null {
  const t = text.trim();
  // Reject swap intent — those go to the atomic recipe, not the price recipe.
  if (/\b(swap|exchange|convert|trade|buy|sell|get|purchase|acquire)\b/i.test(t)) return null;

  // Natural quantity quote: "how many sats is 10 USDT worth?" The amount is
  // on the priced asset (TO leg); the requested denomination is the FROM leg.
  const quantityWorth = t.match(
    /\bhow\s+(?:many|much)\s+([a-z]+)\s+(?:is|are)\s+(\d[\d.,]*)\s+([a-z]+)\s+worth\b/i,
  );
  if (quantityWorth) {
    const denom = knownAsset(quantityWorth[1]);
    const amount = parseAmount(quantityWorth[2]);
    const asset = knownAsset(quantityWorth[3]);
    if (denom && asset && amount != null) {
      return { amount, from_asset: denom, to_asset: asset, amount_side: 'to' };
    }
  }

  // ORDER MATTERS: "how much B for A" (first) must be checked BEFORE
  // "how much X (in Y)?" — otherwise the latter would gobble the first asset
  // and miss the "for/per" tail. Optional "the" article is tolerated
  // ("price of THE usdt") — natural English the maker doesn't care about.
  const priceLike =
    t.match(/\bhow\s+(?:many|much)\s+(?:the\s+)?([a-z]+)\s+(?:for|per|in)\s+(?:1\s+|one\s+|the\s+)?([a-z]+)\b/i) ||
    t.match(/\b(?:price|cost|worth)\s+of\s+(?:the\s+)?([a-z]+)(?:\s+in\s+(?:the\s+)?([a-z]+))?/i) ||
    t.match(/\b(?:the\s+)?([a-z]+)\s+(?:price|cost)\b/i) ||
    t.match(/\brate\s+of\s+(?:the\s+)?([a-z]+)(?:\s+(?:in|to|vs)\s+(?:the\s+)?([a-z]+))?/i) ||
    t.match(/\b(?:the\s+)?([a-z]+)\s+(?:to|vs|in|\/)\s+([a-z]+)\s+rate\b/i) ||
    t.match(/\bhow\s+much\s+(?:does\s+)?(?:1\s+|one\s+|the\s+)?([a-z]+)\s+cost\b/i) ||
    t.match(/\bhow\s+much\s+(?:is\s+)?(?:1\s+|one\s+|the\s+)?([a-z]+)(?:\s+in\s+(?:the\s+)?([a-z]+))?\b/i);
  if (!priceLike) return null;

  const a = knownAsset(priceLike[1]);
  const b = knownAsset(priceLike[2]);
  let asset: string | undefined;
  let denom: string | undefined;
  if (/how\s+(?:many|much)\s+\w+\s+(?:for|per|in)/i.test(t) && b) {
    // "how much B for A" — asset is A (the named priced one), denom is B (unit).
    asset = b; denom = a;
  } else {
    asset = a; denom = b;
  }
  if (!asset) return null;
  const from = denom ?? (asset === 'BTC' ? 'USDT' : 'BTC');
  return { amount: 1, from_asset: from, to_asset: asset, amount_side: 'to' };
}

export const swapRecipe: Recipe = {
  name: 'swap',
  description: 'Swap between BTC and an RGB asset — quote, then execute (with confirmation).',
  // A crypto swap intent — but NOT buying a gift card (that's commerce) or an invoice.
  match: (t) => /\b(swap|exchange|convert|trade)\b/i.test(t) || (/\b(buy|sell)\b/i.test(t) && ASSET.test(t) && !/\b(gift\s?card|top-?up|esim|voucher|invoice|address)\b/i.test(t)),
  triggers: ['swap', 'exchange', 'convert', 'trade'],
  slots: [
    { name: 'from_asset', type: 'string', description: 'Asset to spend (e.g. USDT, BTC)', required: true },
    { name: 'to_asset', type: 'string', description: 'Asset to receive (e.g. BTC, USDT)', required: true },
    { name: 'amount', type: 'number', description: 'Amount to swap' },
  ],
  extract: extractSwap,
  confident: (s) => !!s.from_asset && !!s.to_asset,
  steps: [
    {
      tool: 'get_swap_quote',
      as: 'quote',
      args: (ctx) => ({ from_asset: ctx.slots.from_asset, to_asset: ctx.slots.to_asset, amount: ctx.slots.amount }),
    },
  ],
  final: {
    tool: 'execute_swap',
    args: (ctx) => {
      const q = ctx.results.quote as { quote_id?: string } | undefined;
      return { quote_id: q?.quote_id, from_asset: ctx.slots.from_asset, to_asset: ctx.slots.to_asset, amount: ctx.slots.amount };
    },
  },
  summary: (ctx) => {
    const q = ctx.results.quote as { receive_amount?: number } | undefined;
    const tail = q?.receive_amount ? ` (~${q.receive_amount} ${ctx.slots.to_asset})` : '';
    return `Swapped ${ctx.slots.amount} ${ctx.slots.from_asset} → ${ctx.slots.to_asset}${tail}.`;
  },
};
