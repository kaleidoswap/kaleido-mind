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

function normAsset(a?: string): string | undefined {
  if (!a) return undefined;
  const x = a.toLowerCase();
  if (/btc|bitcoin|sat/.test(x)) return 'BTC';
  if (/usdt|tether/.test(x)) return 'USDT';
  if (/xaut|gold/.test(x)) return 'XAUT';
  return a.toUpperCase();
}
const num = (s?: string) => (s ? Number(s.replace(/,/g, '')) : undefined);

/** "buy 0.001 btc with usdt" / "swap 10 usdt for btc" / "sell 100 usdt for sats". */
export function extractSwap(text: string): Record<string, unknown> | null {
  const t = text.trim();
  let m: RegExpMatchArray | null;
  // buy <amt> <to> with/using <from>  (amount is of the asset being bought)
  if ((m = t.match(/buy\s+([\d.,]+)\s*([a-z]+)\s+(?:with|using|for)\s+([a-z]+)/i))) {
    return { amount: num(m[1]), to_asset: normAsset(m[2]), from_asset: normAsset(m[3]) };
  }
  // swap/sell/convert/exchange/trade <amt> <from> for/to/into <to>
  if ((m = t.match(/(?:swap|sell|convert|exchange|trade)\s+([\d.,]+)\s*([a-z]+)\s+(?:for|to|into)\s+([a-z]+)/i))) {
    return { amount: num(m[1]), from_asset: normAsset(m[2]), to_asset: normAsset(m[3]) };
  }
  return null;
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
