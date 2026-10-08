/**
 * RGB asset balances are raw integers in the asset's own unit, scaled by its
 * `precision`. Nothing in the tool result says so, and small models fill the
 * gap with "satoshis" ("USDT — Balance: 1,000 satoshis").
 *
 * `annotateRgbBalances` adds a `balance_display` next to each asset's
 * `balance` before the result reaches the model ("1,000 USDT").
 * `fixRgbBalanceUnits` corrects a final answer that still labels an asset
 * balance as sats: the number must equal one of that asset's balances and the
 * nearest ticker before it must be that asset's.
 */

type Obj = Record<string, unknown>;

interface RgbAsset {
  ticker: string;
  precision: number;
  amounts: number[];
}

// On-chain fields, plus the asset held in Lightning channels (`offchain_outbound`),
// which is where most RGB-LN users keep it.
const BALANCE_FIELDS = ['settled', 'spendable', 'future', 'offchain_outbound'] as const;

/** On-chain spendable + in channels, in raw units; undefined when neither is reported. */
export function rgbHoldings(balance: unknown): { onchain: number; channels: number; total: number } | undefined {
  if (!isObj(balance)) return undefined;
  const onchainRaw = balance.spendable ?? balance.settled;
  const channelsRaw = balance.offchain_outbound;
  if (typeof onchainRaw !== 'number' && typeof channelsRaw !== 'number') return undefined;
  const onchain = typeof onchainRaw === 'number' ? onchainRaw : 0;
  const channels = typeof channelsRaw === 'number' ? channelsRaw : 0;
  return { onchain, channels, total: onchain + channels };
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function asAsset(v: Obj): RgbAsset | null {
  if (typeof v.ticker !== 'string' || !v.ticker || !isObj(v.balance)) return null;
  const amounts = BALANCE_FIELDS.map((k) => (v.balance as Obj)[k]).filter((n): n is number => typeof n === 'number');
  const held = rgbHoldings(v.balance);
  if (held && held.channels) amounts.push(held.total);
  if (!amounts.length) return null;
  const precision = typeof v.precision === 'number' && v.precision > 0 ? v.precision : 0;
  return { ticker: v.ticker, precision, amounts };
}

/** A raw RGB amount in display units, e.g. 1500000 at precision 6 → "1.5". */
export function formatRgbAmount(raw: number, precision: number): string {
  const value = raw / 10 ** precision;
  return value.toLocaleString('en-US', { maximumFractionDigits: precision });
}

/** Return a copy of `result` where every RGB asset carries `balance_display`. */
export function annotateRgbBalances(result: unknown): unknown {
  if (Array.isArray(result)) return result.map(annotateRgbBalances);
  if (!isObj(result)) return result;
  const out: Obj = {};
  for (const [k, v] of Object.entries(result)) out[k] = annotateRgbBalances(v);
  const asset = asAsset(result);
  if (asset) {
    const balance = result.balance as Obj;
    const display: Obj = {};
    for (const k of BALANCE_FIELDS) {
      if (typeof balance[k] === 'number') display[k] = `${formatRgbAmount(balance[k] as number, asset.precision)} ${asset.ticker}`;
    }
    const held = rgbHoldings(balance);
    if (held?.channels) display.total = `${formatRgbAmount(held.total, asset.precision)} ${asset.ticker}`;
    out.balance_display = display;
  }
  return out;
}

function collectAssets(value: unknown, into: RgbAsset[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collectAssets(v, into);
  } else if (isObj(value)) {
    const asset = asAsset(value);
    if (asset) into.push(asset);
    for (const v of Object.values(value)) collectAssets(v, into);
  }
}

const AMOUNT_IN_SATS = /(\d[\d,]*(?:\.\d+)?)\s*(?:satoshis|sats?)\b/gi;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Relabel asset balances that the answer calls sats, using the tool results it was built from. */
export function fixRgbBalanceUnits(text: string, toolResults: unknown[]): string {
  const assets: RgbAsset[] = [];
  for (const r of toolResults) collectAssets(r, assets);
  if (!assets.length) return text;
  const tickerRe = new RegExp(`\\b(${[...new Set(assets.map((a) => escapeRe(a.ticker)))].join('|')})\\b`, 'g');

  return text.replace(AMOUNT_IN_SATS, (match: string, num: string, offset: number) => {
    let nearest: string | undefined;
    for (const m of text.slice(Math.max(0, offset - 300), offset).matchAll(tickerRe)) nearest = m[1];
    if (!nearest) return match;
    const value = Number(num.replace(/,/g, ''));
    const asset = assets.find(
      (a) => a.ticker === nearest && a.amounts.some((raw) => raw === value || raw / 10 ** a.precision === value),
    );
    if (!asset) return match;
    const raw = asset.amounts.find((r) => r === value) ?? value * 10 ** asset.precision;
    return `${formatRgbAmount(raw, asset.precision)} ${asset.ticker}`;
  });
}
