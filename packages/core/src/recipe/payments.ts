/**
 * Built-in "pay a contact" recipe — the flagship mobile multi-step flow.
 *
 *   "pay bob 3 EUR"  →  resolve_contact → fiat_to_sats → send_payment 🔒
 *   "send 5000 sats to alice"  →  resolve_contact → send_payment 🔒
 *
 * Uses the canonical contract tools. The deterministic extractor handles most
 * phrasings with no LLM at all (Tier-0); the runner falls back to one LLM
 * extraction otherwise.
 */

import type { Recipe, RecipeContext } from './types.js';

const CURRENCIES = /\b(sats?|sat|btc|usdt|xaut|eur|usd|gbp|dollars?|euros?|pounds?)\b/i;
const isOnchainOrInvoice = (s: string) => /^(ln(bc|tb|bcrt)|bc1|tb1|lnurl|[a-z0-9._-]+@)/i.test(s.trim());

function normCurrency(c?: string): string | undefined {
  if (!c) return undefined;
  const x = c.toLowerCase();
  if (/^sat/.test(x)) return 'sats';
  if (x === 'btc') return 'btc';
  if (/dollar|^usd/.test(x)) return 'usd';
  if (/euro|^eur/.test(x)) return 'eur';
  if (/pound|^gbp/.test(x)) return 'gbp';
  return x.toUpperCase();
}

/** "pay bob 3 eur", "send 5,000 sats to alice", "pay lnbc... ", "send 0.001 btc to bob" */
export function extractPayment(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!/\b(pay|send|transfer)\b/i.test(t)) return null;

  // Amount with optional k/m shorthand: "5k" → 5000, "2m" → 2_000_000.
  const amtMatch = t.match(/(\d[\d.,]*)\s*([km])?\b/i);
  let amountNum = amtMatch ? Number(amtMatch[1]!.replace(/,/g, '')) : undefined;
  if (amountNum != null && amtMatch?.[2]) amountNum *= amtMatch[2].toLowerCase() === 'k' ? 1_000 : 1_000_000;
  const amount = amountNum != null && !Number.isNaN(amountNum) ? String(amountNum) : undefined;
  const currency = normCurrency(t.match(CURRENCIES)?.[1]);

  // recipient: prefer "to <x>", else the token right after pay/send that isn't a number/currency
  let recipient = t.match(/\bto\s+([^\s,]+)/i)?.[1];
  if (!recipient) {
    const after = t.match(/\b(?:pay|send|transfer)\s+([^\s,]+)/i)?.[1];
    if (after && !/^\d/.test(after) && !CURRENCIES.test(after)) recipient = after;
  }
  if (!recipient && !amount) return null;
  return {
    recipient,
    amount: amount ? Number(amount) : undefined,
    currency,
  };
}

/** Compute the sats amount when no fiat conversion step is needed. */
function directSats(ctx: RecipeContext): number | undefined {
  const amount = Number(ctx.slots.amount);
  if (!amount || Number.isNaN(amount)) return undefined;
  const cur = String(ctx.slots.currency ?? 'sats').toLowerCase();
  if (cur === 'btc') return Math.round(amount * 1e8);
  return Math.round(amount); // sats (default)
}

const isFiat = (ctx: RecipeContext) => {
  const c = String(ctx.slots.currency ?? '').toLowerCase();
  return c !== '' && c !== 'sats' && c !== 'btc';
};

export const paymentsRecipe: Recipe = {
  name: 'pay-contact',
  description: 'Pay a contact or address — resolves the contact, converts fiat to sats, then sends (with confirmation).',
  // A spend intent, but NOT a receive/invoice ("send me an invoice", "request").
  match: (t) => /\b(pay|send|transfer)\b/i.test(t) && !/\b(invoice|receive|request|address|qr|deposit)\b/i.test(t),
  triggers: ['pay', 'send', 'transfer'],
  slots: [
    { name: 'recipient', type: 'string', description: 'Who to pay: a contact name, Lightning address, or invoice', required: true },
    { name: 'amount', type: 'number', description: 'The amount to send' },
    { name: 'currency', type: 'string', description: 'Unit of the amount: sats, btc, or a fiat code like eur/usd' },
  ],
  extract: extractPayment,
  steps: [
    {
      // Resolve a contact name → payable address (skip if already an address/invoice).
      tool: 'resolve_contact',
      as: 'contact',
      args: (ctx) => ({ name: ctx.slots.recipient }),
      skipIf: (ctx) => !ctx.slots.recipient || isOnchainOrInvoice(String(ctx.slots.recipient)),
    },
    {
      // Convert fiat → sats (skip when the amount is already sats/btc or absent).
      tool: 'fiat_to_sats',
      as: 'conv',
      args: (ctx) => ({ amount: ctx.slots.amount, currency: ctx.slots.currency }),
      skipIf: (ctx) => !ctx.slots.amount || !isFiat(ctx),
    },
  ],
  final: {
    tool: 'send_payment',
    args: (ctx) => {
      const contact = ctx.results.contact as { ln_address?: string } | undefined;
      const conv = ctx.results.conv as { sats?: number } | undefined;
      return {
        to: contact?.ln_address ?? ctx.slots.recipient,
        amount_sats: conv?.sats ?? directSats(ctx),
      };
    },
  },
  summary: (ctx) => {
    const conv = ctx.results.conv as { sats?: number } | undefined;
    const sats = conv?.sats ?? directSats(ctx);
    const to = (ctx.results.contact as { name?: string } | undefined)?.name ?? ctx.slots.recipient;
    return sats ? `Sent ${sats.toLocaleString()} sats to ${to}.` : `Payment sent to ${to}.`;
  },
};
