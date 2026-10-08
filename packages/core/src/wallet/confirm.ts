/**
 * Confirm-sheet readback — a deterministic, voice-first summary of a spend that
 * the host speaks before executing it ("Send 4,800 sats to bob over Spark.
 * Confirm?"). Built from the resolved tool call, not the model: zero inference,
 * identical on every surface, and impossible for the model to phrase around.
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

/** Looks like an address/invoice/lnurl (vs a human contact name). */
function isRef(s: string): boolean {
  return /^(ln(bc|tb|bcrt)|bc1|tb1|lq1|lnurl)/i.test(s) || (s.length > 20 && !/\s/.test(s));
}

/** Shorten an address/invoice for speech; leave contact names intact. */
function shortRef(s: string): string {
  const v = s.trim();
  return isRef(v) && v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v;
}

/** " over Spark" suffix for the call's layer (explicit arg wins, else the tool's). */
function over(name: string, args: Record<string, unknown>): string {
  const layer = typeof args.layer === 'string' ? args.layer : getWalletTool(name)?.layer;
  const label = layer ? LAYER_LABEL[layer] : undefined;
  return label ? ` over ${label}` : '';
}

/** A finite number from a tool arg, else undefined (never NaN in a readback). */
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** A display string from a tool arg, stripped of stray quotes/commas a model may leave in. */
function label(v: unknown): string {
  return String(v ?? '').trim().replace(/^[\s'"`,]+|[\s'"`,]+$/g, '') || '?';
}

const sats = (v: unknown) => {
  const n = num(v);
  return n === undefined ? 'an unspecified amount of sats' : `${fmtNum(n)} sats`;
};
const asset = (amount: unknown, ticker: unknown) => {
  const n = num(amount);
  return n === undefined ? `an unspecified amount of ${label(ticker)}` : `${fmtNum(n)} ${label(ticker)}`;
};

/** A spoken confirmation ending in "Confirm?", or null for non-spend tools. */
/** What earlier calls in the same run returned, for readbacks that depend on them. */
export interface ReadbackContext {
  results?: Array<{ name: string; result: unknown }>;
}

type QuoteLeg = { ticker?: string; layer?: string; amount_raw?: number; amount_display?: string };

const isBtcLeg = (leg?: QuoteLeg) => leg?.layer === 'BTC_LN' || (!leg?.layer && String(leg?.ticker ?? '').toUpperCase() === 'BTC');

// BTC reads in sats from the raw msat amount (the maker's display is in BTC).
const legText = (leg?: QuoteLeg) =>
  isBtcLeg(leg) && Number.isFinite(Number(leg?.amount_raw))
    ? sats(Math.floor(Number(leg!.amount_raw) / 1000))
    : leg?.amount_display
      ? `${leg.amount_display}${leg.ticker && !/sats?$/i.test(leg.amount_display) ? ` ${leg.ticker}` : ''}`
      : undefined;

const lastResult = (ctx: ReadbackContext | undefined, re: RegExp): Record<string, any> | undefined => {
  const hit = [...(ctx?.results ?? [])].reverse().find((r) => re.test(r.name));
  let r = hit?.result;
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r);
    } catch {
      return undefined;
    }
  }
  return r && typeof r === 'object' ? (r as Record<string, any>) : undefined;
};

/** RLN swapstring: qty_from/from_asset/qty_to/to_asset/expiry/payment_hash (BTC in msat). */
function swapstringLegs(swapstring: string): string | undefined {
  const [qtyFrom, from, qtyTo, to] = swapstring.split('/');
  if (!qtyFrom || !from || !qtyTo || !to || !/^\d+$/.test(qtyFrom) || !/^\d+$/.test(qtyTo)) return undefined;
  const leg = (qty: string, asset: string) =>
    asset === 'btc' ? sats(Math.floor(Number(qty) / 1000)) : `${Number(qty).toLocaleString('en-US')} units of ${shortRef(asset)}`;
  return `${leg(qtyFrom, from)} ⇄ ${leg(qtyTo, to)}`;
}

function expiresIn(expiresAt: unknown): string {
  const t = Number(expiresAt);
  if (!Number.isFinite(t) || t <= 0) return '';
  const secs = Math.round((t > 1e12 ? t : t * 1000) / 1000 - Date.now() / 1000);
  return secs > 0 ? ` (quote expires in ${secs}s)` : ' (the quote has expired)';
}

/** One leg from init args alone: BTC raw is msat; an asset's raw units without its precision. */
function rawLeg(assetId: unknown, raw: unknown): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return String(assetId ?? '?');
  return /^(btc|sats?)$/i.test(String(assetId ?? '')) ? sats(Math.floor(n / 1000)) : `${n.toLocaleString('en-US')} raw units of ${shortRef(String(assetId ?? '?'))}`;
}

function atomicInitReadback(a: Record<string, unknown>, ctx?: ReadbackContext): string {
  const quote = lastResult(ctx, /(^|_)get_quote$/);
  const from = legText(quote?.from_asset);
  const to = legText(quote?.to_asset);
  if (quote && from && to && (!a.rfq_id || !quote.rfq_id || a.rfq_id === quote.rfq_id)) {
    const differs =
      (a.from_amount_raw != null && quote.from_asset?.amount_raw != null && Number(a.from_amount_raw) !== Number(quote.from_asset.amount_raw)) ||
      (a.to_amount_raw != null && quote.to_asset?.amount_raw != null && Number(a.to_amount_raw) !== Number(quote.to_asset.amount_raw));
    return `Swap ${from} for ${to} on KaleidoSwap${expiresIn(quote.expires_at)}${differs ? ' (the amounts sent differ from the quote)' : ''}`;
  }
  return `Swap ${rawLeg(a.from_asset_id, a.from_amount_raw)} for ${rawLeg(a.to_asset_id, a.to_amount_raw)} on KaleidoSwap (no quote in this conversation)`;
}

function atomicExecuteReadback(ctx?: ReadbackContext): string {
  const quote = lastResult(ctx, /(^|_)get_quote$/);
  const from = legText(quote?.from_asset);
  const to = legText(quote?.to_asset);
  return from && to ? `Settle the KaleidoSwap swap: you send ${from}, you receive ${to}` : 'Settle the KaleidoSwap atomic swap';
}

function atomicTakerReadback(swapstring: string, ctx?: ReadbackContext): string {
  const quote = lastResult(ctx, /(^|_)get_quote$/);
  const init = lastResult(ctx, /(^|_)atomic_init$/);
  const from = legText(quote?.from_asset);
  const to = legText(quote?.to_asset);
  if (from && to) {
    const other = init?.swapstring && init.swapstring !== swapstring ? ' (this is not the swap just created)' : '';
    return `Accept the atomic swap: you send ${from}, you receive ${to}${other}`;
  }
  const legs = swapstringLegs(swapstring);
  return legs ? `Accept atomic swap ${legs} (${shortRef(swapstring)})` : `Accept atomic swap ${shortRef(swapstring)}`;
}

export function confirmReadback(call: { name: string; arguments: Record<string, unknown> }, context?: ReadbackContext): string | null {
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
      // kaleido-mcp names these asset_id / recipient_id.
      return ask(`Send ${asset(a.amount, a.asset ?? shortRef(String(a.asset_id ?? '')))} to ${to(a.to != null ? 'to' : 'recipient_id')}${over(name, a)}`);
    case 'rln_pay_invoice':
    case 'spark_pay_invoice':
      return ask(`Pay Lightning invoice ${shortRef(String(a.invoice ?? ''))}${over(name, a)}`);
    case 'rln_issue_asset': {
      const named = a.name != null && a.ticker != null && label(a.name) !== label(a.ticker) ? ` (${label(a.name)})` : '';
      return a.schema === 'UDA'
        ? ask(`Issue unique asset ${label(a.ticker ?? a.name)}${named} on RGB`)
        : ask(`Issue ${asset(a.amount, a.ticker ?? a.name)}${named}, a new RGB asset`);
    }
    case 'rln_create_utxos':
      return ask(`Create ${fmtNum(num(a.num) ?? 5)} RGB UTXOs on-chain${over(name, a)}`);
    case 'rln_send_btc':
      return ask(`Send ${sats(a.amount_sat)} on-chain to ${to('address')}${over(name, a)}`);
    case 'rln_open_channel': {
      const peer = shortRef(String(a.peer_pubkey_and_addr ?? '').split('@')[0] ?? '');
      const withAsset = a.asset_id != null && num(a.asset_amount) !== undefined ? ` with ${fmtNum(num(a.asset_amount)!)} of ${shortRef(String(a.asset_id))}` : '';
      return ask(`Open a ${sats(a.capacity_sat)} channel to ${peer}${withAsset}`);
    }
    case 'rln_close_channel':
      return ask(`${a.force ? 'Force-close' : 'Close'} channel ${shortRef(String(a.channel_id ?? ''))}`);
    case 'kaleidoswap_atomic_init':
      return ask(atomicInitReadback(a, context));
    case 'kaleidoswap_atomic_execute':
      return ask(atomicExecuteReadback(context));
    case 'rln_atomic_taker':
    case 'wdk_atomic_taker':
      return ask(atomicTakerReadback(String(a.swapstring ?? ''), context));
    case 'execute_swap':
      return ask(`Swap ${asset(a.amount, a.from_asset)} for ${label(a.to_asset)}`);
    // The order total is only known once the LSP creates the order; the
    // payment that follows is confirmed separately with that amount.
    case 'lsp_create_order':
    case 'kaleidoswap_lsp_create_order': {
      const pushed = num(a.client_balance_sat) ? `, ${sats(a.client_balance_sat)} pushed to you` : '';
      return ask(`Order a Lightning channel from the LSP with ${sats(a.lsp_balance_sat)} inbound${pushed}. The order total is paid in a separate step`);
    }
    case 'kaleidoswap_lsp_create_asset_channel':
      return ask(`Order a channel from the LSP with ${asset(a.asset_amount, a.asset)} inbound. The order total is paid in a separate step`);
    default:
      // Unknown but spend-flagged tool → a generic, still-honest readback.
      return getWalletTool(name)?.spend ? ask(`Confirm ${name.replace(/_/g, ' ')}`) : null;
  }
}
