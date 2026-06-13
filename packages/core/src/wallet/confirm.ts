/**
 * Confirm-sheet readback — a deterministic, voice-first summary of a spend
 * BEFORE it executes. Confirm-before-spend is structural (every fund-moving
 * tool is `requiresConfirmation`), but on a voice-first mobile wallet the
 * *readback* is where unit/recipient mistakes get caught. So the host speaks
 * this line on the confirm sheet — "Send 4,800 sats to bob over Spark. Confirm?"
 *
 * Built from the resolved tool call, NOT the model: zero inference, identical on
 * every surface, and impossible for the model to phrase around. Pure + RN-safe.
 *
 *   const line = confirmReadback({ name: 'send_payment', arguments: { to: 'bob', amount_sats: 4800 } })
 *   await speak(line)            // in the host's onConfirm, before showing the sheet
 */

import { getWalletTool } from './contract.js';

const LAYER_LABEL: Record<string, string> = {
  spark: 'Spark',
  rln: 'RLN',
  arkade: 'Arkade',
  liquid: 'Liquid',
};

/** Group an integer with thousands separators, locale-independently (test-stable). */
function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const neg = n < 0;
  const [int, frac] = Math.abs(n).toString().split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + (frac ? `${grouped}.${frac}` : grouped);
}

/** Looks like an on-chain address / invoice / lnurl (vs a human contact name). */
function isRef(s: string): boolean {
  return /^(ln(bc|tb|bcrt)|bc1|tb1|lq1|lnurl)/i.test(s) || (s.length > 20 && !/\s/.test(s));
}

/** Shorten an address/invoice for speech; leave contact names intact. */
function shortRef(s: string): string {
  const v = s.trim();
  return isRef(v) ? `${v.slice(0, 6)}…${v.slice(-4)}` : v;
}

/** " over Spark" suffix for the call's layer (explicit arg wins, else the tool's). */
function over(name: string, args: Record<string, unknown>): string {
  const layer = typeof args.layer === 'string' ? args.layer : getWalletTool(name)?.layer;
  const label = layer ? LAYER_LABEL[layer] : undefined;
  return label ? ` over ${label}` : '';
}

const sats = (v: unknown) => `${fmtNum(Number(v))} sats`;
const asset = (amount: unknown, ticker: unknown) => `${fmtNum(Number(amount))} ${String(ticker)}`;

/**
 * A short spoken confirmation for a (spend) tool call, ending in "Confirm?".
 * Returns `null` for non-spend / unknown tools — nothing to read back.
 */
export function confirmReadback(call: { name: string; arguments: Record<string, unknown> }): string | null {
  const { name, arguments: a } = call;
  const to = (k = 'to') => shortRef(String(a[k] ?? ''));
  const ask = (s: string) => `${s}. Confirm?`;

  switch (name) {
    case 'send_payment': {
      const amt = a.amount_sats != null ? sats(a.amount_sats)
        : a.asset != null && a.amount != null ? asset(a.amount, a.asset)
        : undefined;
      return ask(amt ? `Send ${amt} to ${to()}${over(name, a)}` : `Send a payment to ${to()}${over(name, a)}`);
    }
    case 'spark_send':
    case 'arkade_send':
      return ask(`Send ${sats(a.amount_sats)} to ${to()}${over(name, a)}`);
    case 'rln_send_asset':
    case 'liquid_send':
      return ask(`Send ${asset(a.amount, a.asset)} to ${to()}${over(name, a)}`);
    case 'rln_pay_invoice':
      return ask(`Pay Lightning invoice ${shortRef(String(a.invoice ?? ''))}${over(name, a)}`);
    case 'execute_swap':
      return ask(`Swap ${fmtNum(Number(a.amount))} ${String(a.from_asset)} for ${String(a.to_asset)}`);
    default:
      // Unknown but spend-flagged tool → a generic, still-honest readback.
      return getWalletTool(name)?.spend ? ask(`Confirm ${name.replace(/_/g, ' ')}`) : null;
  }
}
