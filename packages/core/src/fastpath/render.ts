/**
 * Text for a fast-path result. Tools that answer the same intent return
 * different shapes (aggregate wallet, kaleido-mcp, MockWallet), so each shape
 * is read here instead of asking a model to describe it.
 */
import { formatRgbAmount, rgbHoldings } from '../context/rgb-units.js';

type Obj = Record<string, any>;

const sats = (n: unknown) => n == null || n === '' || !Number.isFinite(Number(n)) ? 'not verified' : `${Number(n).toLocaleString('en-US')} sats`;

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

function renderChannels(r: Obj, requested?: number): string {
  if (!Array.isArray(r?.channels)) return 'Channel liquidity not verified.';
  const usable = r.channels.filter((c: Obj) => c.is_usable === true && c.ready !== false);
  const valid = (v: unknown) => v != null && Number.isFinite(Number(v)) && Number(v) >= 0;
  if (usable.some((c: Obj) => !valid(c.outbound_balance_msat) || !valid(c.inbound_balance_msat))) return 'Channel liquidity not verified.';
  const outbound = usable.reduce((sum: number, c: Obj) => sum + Number(c.outbound_balance_msat), 0) / 1000;
  const inbound = usable.reduce((sum: number, c: Obj) => sum + Number(c.inbound_balance_msat), 0) / 1000;
  let text = `${usable.length} usable channels. Send: ${sats(outbound)}. Receive: ${sats(inbound)}.`;
  if (requested !== undefined) {
    const limitsKnown = usable.every((c: Obj) => valid(c.next_outbound_htlc_limit_msat));
    const max = limitsKnown ? Math.max(0, ...usable.map((c: Obj) => Math.min(Number(c.outbound_balance_msat), Number(c.next_outbound_htlc_limit_msat)) / 1000)) : null;
    text += max === null ? '\nSingle-HTLC limit not verified.' : `\nSingle-HTLC maximum: ${sats(max)}. ${requested > outbound || requested > max ? 'No: requested amount exceeds available liquidity or the single-HTLC limit.' : 'Within the local upper limit; routing, minimum HTLC and fees still need checking. This does not guarantee payment success.'}`;
  }
  return text;
}

export function defaultRenderFast(intent: string, result: unknown, extra?: Record<string, unknown>): string {
  const r = parse(result) as Obj;
  if (r?.error || r?.isError) return `Could not verify: ${String(r.error ?? 'tool failed')}`;
  if (intent === 'channels' || intent === 'payment-capacity') return renderChannels(r, extra?.requestedSats as number | undefined);
  if (intent === 'balance') {
    const text = renderBalance(r ?? {});
    const parts = [text];
    if (extra && 'assets' in extra) parts.push(defaultRenderFast('assets', extra.assets));
    if (extra && 'channels' in extra) parts.push(defaultRenderFast('channels', extra.channels));
    return parts.join('\n');
  }
  if (intent === 'assets') return renderAssets(r);
  if (intent === 'address') {
    return r?.address ? `Here's your receive address:\n\n\`${r.address}\`` : 'No address available right now.';
  }
  return `Bitcoin is $${Number(r?.price_usd ?? 0).toLocaleString('en-US')}.`;
}
