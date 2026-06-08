/**
 * Built-in "receive" recipe — create an invoice/address to get paid.
 *
 *   "create an invoice for 5000 sats"   → BTC invoice, 5000 sats
 *   "an invoice"                        → BTC invoice, any amount
 *   "invoice for 25 USDT on Liquid"     → USDT, Liquid
 *
 * Single deterministic step over the `create_invoice` router (which picks the
 * right rail for the asset/layer). Not a spend → no confirmation gate.
 */

import type { Recipe } from './types.js';

const ASSET = /\b(btc|bitcoin|sats?|usdt|tether|xaut|gold)\b/i;
const LAYER = /\b(spark|arkade|liquid|rln|lightning|rgb)\b/i;

function normAsset(a?: string): string | undefined {
  if (!a) return undefined;
  const x = a.toLowerCase();
  if (/btc|bitcoin|sat/.test(x)) return 'BTC';
  if (/usdt|tether/.test(x)) return 'USDT';
  if (/xaut|gold/.test(x)) return 'XAUT';
  return a.toUpperCase();
}
function normLayer(l?: string): string | undefined {
  if (!l) return undefined;
  const x = l.toLowerCase();
  if (x === 'lightning' || x === 'rgb') return 'rln';
  if (['spark', 'arkade', 'liquid', 'rln'].includes(x)) return x;
  return undefined;
}
function parseAmount(t: string): number | undefined {
  const m = t.match(/(\d[\d.,]*)\s*([km])?\b/i);
  if (!m) return undefined;
  let n = Number(m[1]!.replace(/,/g, ''));
  if (m[2]) n *= m[2].toLowerCase() === 'k' ? 1_000 : 1_000_000;
  return Number.isNaN(n) ? undefined : n;
}

const RECEIVE_INTENT = /\b(invoice|receive|deposit|get paid|pay me|request (a )?payment)\b/i;

export function extractReceive(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!RECEIVE_INTENT.test(t)) return null;
  const amount = parseAmount(t);
  const asset = normAsset(t.match(ASSET)?.[1]);
  const layer = normLayer(t.match(LAYER)?.[1]);
  return {
    ...(amount != null ? { amount } : {}),
    ...(asset ? { asset } : {}),
    ...(layer ? { layer } : {}),
  };
}

export const receiveRecipe: Recipe = {
  name: 'receive',
  description: 'Create an invoice or address to receive funds (BTC or an RGB asset, on a chosen rail).',
  // A receive intent, NOT a send/swap.
  match: (t) => RECEIVE_INTENT.test(t) && !/\b(pay|send|transfer|swap|buy|sell)\b/i.test(t),
  triggers: ['invoice', 'receive', 'deposit'],
  slots: [
    { name: 'amount', type: 'number', description: 'Amount to receive — sats for BTC, asset units otherwise (optional)' },
    { name: 'asset', type: 'string', description: 'Asset: BTC, USDT, XAUT (default BTC)' },
    { name: 'layer', type: 'string', description: 'Rail: spark, rln, liquid (optional)' },
  ],
  extract: extractReceive,
  // Any receive request fires — an any-amount BTC invoice is valid.
  confident: () => true,
  steps: [],
  final: {
    tool: 'create_invoice',
    args: (ctx) => ({
      asset: ctx.slots.asset ?? 'BTC',
      amount: ctx.slots.amount,
      layer: ctx.slots.layer,
    }),
  },
  summary: (ctx, result) => {
    const r = result as { invoice?: string; address?: string } | undefined;
    const dest = r?.invoice ?? r?.address ?? '';
    const amt = ctx.slots.amount ? `${ctx.slots.amount} ${ctx.slots.asset ?? 'sats'}` : 'any amount';
    return dest ? `Here's your ${ctx.slots.asset ?? 'BTC'} invoice for ${amt}:\n\n${dest}` : `Created an invoice for ${amt}.`;
  },
};
