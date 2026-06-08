/**
 * Built-in "send an RGB asset" recipe — distinct from the BTC payments recipe
 * because an asset amount must NOT be treated as fiat.
 *
 *   "send 10 USDT to bob"     → resolve_contact → rln_send_asset 🔒
 *   "pay alice 5 XAUT"        → resolve_contact → rln_send_asset 🔒
 *
 * Fixes the bug where the payments recipe parsed "USDT" as a fiat currency and
 * ran fiat_to_sats. Payments now excludes RGB assets; this recipe owns them.
 */

import type { Recipe, RecipeContext } from './types.js';

const RGB_ASSET = /\b(usdt|tether|xaut|gold)\b/i;
const isOnchainOrInvoice = (s: string) => /^(ln(bc|tb|bcrt)|bc1|tb1|lnurl|rgb:|[a-z0-9._-]+@)/i.test(s.trim());

function normAsset(a?: string): string | undefined {
  if (!a) return undefined;
  const x = a.toLowerCase();
  if (/usdt|tether/.test(x)) return 'USDT';
  if (/xaut|gold/.test(x)) return 'XAUT';
  return a.toUpperCase();
}
function parseAmount(t: string): number | undefined {
  const m = t.match(/(\d[\d.,]*)\s*([km])?\b/i);
  if (!m) return undefined;
  let n = Number(m[1]!.replace(/,/g, ''));
  if (m[2]) n *= m[2].toLowerCase() === 'k' ? 1_000 : 1_000_000;
  return Number.isNaN(n) ? undefined : n;
}

/** "send 10 USDT to bob" / "pay alice 5 xaut". */
export function extractAssetSend(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!/\b(send|pay|transfer)\b/i.test(t)) return null;
  const asset = normAsset(t.match(RGB_ASSET)?.[1]);
  if (!asset) return null; // not an asset send → let the payments recipe handle it
  const amount = parseAmount(t);
  let recipient = t.match(/\bto\s+([^\s,]+)/i)?.[1];
  if (!recipient) {
    const after = t.match(/\b(?:pay|send|transfer)\s+([^\s,]+)/i)?.[1];
    if (after && !/^\d/.test(after) && !RGB_ASSET.test(after)) recipient = after;
  }
  if (!recipient && amount == null) return null;
  return { recipient, asset, amount };
}

export const assetSendRecipe: Recipe = {
  name: 'pay-asset',
  description: 'Send an RGB asset (USDT, XAUT) to a contact or address — resolves the contact, then sends (with confirmation).',
  match: (t) => /\b(send|pay|transfer)\b/i.test(t) && RGB_ASSET.test(t) && !/\b(invoice|receive|swap|buy|sell|for)\b/i.test(t),
  triggers: ['send', 'pay', 'transfer'],
  slots: [
    { name: 'recipient', type: 'string', description: 'Contact name, address, or RGB invoice', required: true },
    { name: 'asset', type: 'string', description: 'RGB asset: USDT or XAUT', required: true },
    { name: 'amount', type: 'number', description: 'Asset amount' },
  ],
  extract: extractAssetSend,
  confident: (s) => !!s.recipient && !!s.asset,
  steps: [
    {
      tool: 'resolve_contact',
      as: 'contact',
      args: (ctx) => ({ name: ctx.slots.recipient }),
      skipIf: (ctx) => !ctx.slots.recipient || isOnchainOrInvoice(String(ctx.slots.recipient)),
    },
  ],
  final: {
    tool: 'rln_send_asset',
    args: (ctx: RecipeContext) => {
      const contact = ctx.results.contact as { ln_address?: string } | undefined;
      return { asset: ctx.slots.asset, amount: ctx.slots.amount, to: contact?.ln_address ?? ctx.slots.recipient };
    },
  },
  summary: (ctx) => {
    const to = (ctx.results.contact as { name?: string } | undefined)?.name ?? ctx.slots.recipient;
    return `Sent ${ctx.slots.amount} ${ctx.slots.asset} to ${to}.`;
  },
};
