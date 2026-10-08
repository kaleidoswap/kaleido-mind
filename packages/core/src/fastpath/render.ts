/**
 * Text for a fast-path result. Tools that answer the same intent return
 * different shapes (aggregate wallet, kaleido-mcp, MockWallet), so each shape
 * is read here instead of asking a model to describe it.
 */
import { formatRgbAmount, rgbHoldings } from '../context/rgb-units.js';

type Obj = Record<string, any>;

const sats = (n: unknown) => `${Number(n ?? 0).toLocaleString('en-US')} sats`;

function parse(r: unknown): unknown {
  if (typeof r !== 'string') return r;
  try {
    return JSON.parse(r);
  } catch {
    return r;
  }
}

function renderBalance(r: Obj): string {
  if (r.total_sats !== undefined) {
    const n = r.layers?.length ?? 0;
    return `You have ${sats(r.total_sats)}${n > 1 ? ` across ${n} layers` : ''}.`;
  }
  if (r.btc_onchain) {
    const b = r.btc_onchain;
    const lines = [`On-chain: ${sats(b.vanilla_spendable_sats)} spendable.`];
    if (Number(b.colored_spendable_sats)) lines.push(`RGB UTXOs: ${sats(b.colored_spendable_sats)} (holding RGB assets, not for spending).`);
    if (r.lightning_balance_sat !== undefined) lines.push(`Lightning: ${sats(r.lightning_balance_sat)}.`);
    return lines.join('\n');
  }
  if (r.btc_sats !== undefined) return `You have ${sats(r.btc_sats)}.`;
  return `Balances:\n${JSON.stringify(r, null, 2)}`;
}

function renderAssets(r: unknown): string {
  const list: Obj[] = Array.isArray(r) ? r : Array.isArray((r as Obj)?.assets) ? (r as Obj).assets : [];
  if (!list.length) return "You don't hold any RGB assets yet.";
  const rows = list.map((a) => {
    const held = rgbHoldings(a.balance);
    const fmt = (raw: number) => formatRgbAmount(raw, Number(a.precision) || 0);
    const amount = !held
      ? 'balance unknown'
      : held.channels
        ? `${fmt(held.total)} ${a.ticker} (${fmt(held.channels)} in channels, ${fmt(held.onchain)} on-chain)`
        : `${fmt(held.total)} ${a.ticker}`;
    return `- ${a.ticker}${a.name && a.name !== a.ticker ? ` (${a.name})` : ''}: ${amount}`;
  });
  return `Your RGB assets:\n${rows.join('\n')}`;
}

export function defaultRenderFast(intent: string, result: unknown, extra?: Record<string, unknown>): string {
  const r = parse(result) as Obj;
  if (intent === 'balance') {
    const text = renderBalance(r ?? {});
    return extra && 'assets' in extra ? `${text}\n${renderAssets(parse(extra.assets))}` : text;
  }
  if (intent === 'assets') return renderAssets(r);
  if (intent === 'address') {
    return r?.address ? `Here's your receive address:\n\n\`${r.address}\`` : 'No address available right now.';
  }
  return `Bitcoin is $${Number(r?.price_usd ?? 0).toLocaleString('en-US')}.`;
}
