/**
 * Built-in "receive" recipe — create an invoice/address to get paid, in sats,
 * BTC, an RGB asset, OR a fiat amount (converted to sats deterministically so a
 * small model never mis-parses "$2.00").
 *
 *   "invoice for 5000 sats"            → BTC invoice, 5000 sats
 *   "create a payment request of $2"   → fiat_to_sats(2, USD) → BTC invoice
 *   "invoice for 25 USDT on Liquid"    → RGB asset invoice
 *   "an invoice"                       → BTC invoice, any amount
 */

import type { Recipe } from './types.js';

const LAYER = /\b(spark|arkade|liquid|rln|lightning|rgb)\b/i;
const RECEIVE_INTENT = /\b(invoice|receive|deposit|get paid|pay me|payment request|request (a )?payment)\b/i;

type Kind = 'sats' | 'btc' | 'fiat' | 'asset';

function classify(text: string): { kind: Kind; code: string } {
  if (/\$|\busd\b|dollar/i.test(text)) return { kind: 'fiat', code: 'USD' };
  if (/€|\beur\b|euro/i.test(text)) return { kind: 'fiat', code: 'EUR' };
  if (/£|\bgbp\b|pound/i.test(text)) return { kind: 'fiat', code: 'GBP' };
  if (/usdt|tether/i.test(text)) return { kind: 'asset', code: 'USDT' };
  if (/xaut|gold/i.test(text)) return { kind: 'asset', code: 'XAUT' };
  if (/\bbtc\b|bitcoin/i.test(text)) return { kind: 'btc', code: 'BTC' };
  return { kind: 'sats', code: 'BTC' }; // default: sats
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

export function extractReceive(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!RECEIVE_INTENT.test(t)) return null;
  const amount = parseAmount(t);
  const { kind, code } = classify(t);
  const layer = normLayer(t.match(LAYER)?.[1]);
  return { ...(amount != null ? { amount } : {}), kind, currency: code, ...(layer ? { layer } : {}) };
}

export const receiveRecipe: Recipe = {
  name: 'receive',
  description: 'Create an invoice/address to receive funds — sats, BTC, a fiat amount (converted), or an RGB asset.',
  match: (t) => RECEIVE_INTENT.test(t) && !/\b(send|transfer|swap|buy|sell)\b/i.test(t),
  triggers: ['invoice', 'receive', 'deposit', 'payment request'],
  slots: [
    { name: 'amount', type: 'number', description: 'Amount to receive (optional)' },
    { name: 'currency', type: 'string', description: 'sats | BTC | USD | EUR | USDT | XAUT' },
    { name: 'layer', type: 'string', description: 'Rail: spark, rln, liquid (optional)' },
  ],
  extract: extractReceive,
  confident: () => true,
  steps: [
    {
      // Fiat → sats, only when the amount is fiat-denominated.
      tool: 'fiat_to_sats',
      as: 'conv',
      args: (ctx) => ({ amount: ctx.slots.amount, currency: ctx.slots.currency }),
      skipIf: (ctx) => ctx.slots.kind !== 'fiat' || ctx.slots.amount == null,
    },
  ],
  final: {
    tool: 'create_invoice',
    args: (ctx) => {
      const kind = ctx.slots.kind as Kind;
      const conv = ctx.results.conv as { sats?: number } | undefined;
      let asset = 'BTC';
      let amount = ctx.slots.amount as number | undefined;
      if (kind === 'asset') asset = String(ctx.slots.currency);
      else if (kind === 'fiat') amount = conv?.sats;
      else if (kind === 'btc' && amount != null) amount = Math.round(amount * 1e8); // sats
      return { asset, amount, layer: ctx.slots.layer };
    },
  },
  summary: (ctx, result) => {
    const r = result as { invoice?: string; address?: string } | undefined;
    const dest = r?.invoice ?? r?.address ?? '';
    const kind = ctx.slots.kind as Kind;
    const conv = ctx.results.conv as { sats?: number } | undefined;
    let amt = 'any amount';
    if (kind === 'fiat' && ctx.slots.amount != null) amt = `${ctx.slots.currency} ${ctx.slots.amount} (${(conv?.sats ?? 0).toLocaleString()} sats)`;
    else if (kind === 'asset' && ctx.slots.amount != null) amt = `${Number(ctx.slots.amount).toLocaleString()} ${ctx.slots.currency}`;
    else if (ctx.slots.amount != null) amt = `${Number(ctx.slots.amount).toLocaleString()} ${kind === 'btc' ? 'BTC' : 'sats'}`;
    const label = kind === 'asset' ? String(ctx.slots.currency) : 'BTC';
    return dest ? `Here's your ${label} invoice for ${amt}:\n\n${dest}` : `Created an invoice for ${amt}.`;
  },
};
