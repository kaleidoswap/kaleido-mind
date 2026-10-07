/**
 * Canonical KaleidoSwap tool contract — the single source of truth for the
 * agent-facing tools that drive the KaleidoSwap maker.
 *
 * Every surface implements THESE EXACT tools, only the transport differs:
 *   - mobile  → in-process handlers over the WDK protocol package
 *               (`@kaleidorg/wdk-protocol-swap-kaleidoswap`) via `bindKaleidoswapTools`
 *   - desktop → HTTP / kaleido-mcp / kaleido-cli, also via `bindKaleidoswapTools`
 *   - eval    → stub handlers, also via `bindKaleidoswapTools`
 *
 * Because the schemas are identical everywhere, skills are portable and the
 * model comparison is honest. Tools are grouped (`market`, `atomic`,
 * `liquidity`) so a host can expose a read-only subset for sandbox/eval modes.
 *
 * Spend tools (init/execute an atomic swap, buy an asset channel) carry
 * `spend: true` → `requiresConfirmation: true`, so the Engine always pauses
 * for the host's confirm gate before executing.
 *
 * Pure data — no deps, no fetch, RN-safe.
 */

import type { ToolDef } from '../types.js';
import { InProcessToolSource } from '../tools/in-process.js';
import type { InProcessTool } from '../tools/in-process.js';

/** Functional grouping for selective binding (e.g. read-only sandbox). */
export type KaleidoswapGroup = 'market' | 'atomic' | 'liquidity';

export interface KaleidoswapToolDef extends ToolDef {
  /** Functional group — lets a host expose a subset. */
  group: KaleidoswapGroup;
  /** Moves funds → confirmation-gated. */
  spend?: boolean;
}

type Props = Record<string, { type: string; description?: string; enum?: string[] }>;

function t(
  group: KaleidoswapGroup,
  name: string,
  description: string,
  properties: Props = {},
  required: string[] = [],
  spend = false,
): KaleidoswapToolDef {
  return {
    group,
    name,
    description,
    spend,
    requiresConfirmation: spend,
    parameters: { type: 'object', properties, required },
  };
}

/**
 * The canonical KaleidoSwap tool list. Schema is intentionally agent-facing —
 * each host's adapter translates these args into the underlying transport's
 * request body (maker REST JSON, WDK protocol calls, MCP, etc.).
 */
export const KALEIDOSWAP_TOOLS: KaleidoswapToolDef[] = [
  // ─── market (read) ─────────────────────────────────────────────────────
  t('market',
    'kaleidoswap_get_assets',
    'List the assets KaleidoSwap supports — BTC plus the RGB assets the maker has inventory for (e.g. USDT, XAUT). Returns symbol, precision, and issuer/contract id. No args.'),

  t('market',
    'kaleidoswap_get_pairs',
    'List the trading pairs currently quoted by the maker, with the latest bid/ask and the minimum/maximum executable size on each side. Use this before quoting to pick a valid pair. No args.'),

  t('market',
    'kaleidoswap_get_quote',
    'Get an executable quote for one pair. Amounts are DISPLAY units (0.0005 = 0.0005 BTC = 50,000 sats). Give exactly one of from_amount (sell a fixed input) or to_amount (buy a fixed output). Returns rfq_id, from_asset/to_asset with amount_display and amount_raw, price and expires_at (~60s).',
    {
      from_asset_id: { type: 'string', description: "Asset to sell: ticker ('BTC', 'USDT') or RGB id ('rgb:…')." },
      to_asset_id:   { type: 'string', description: "Asset to buy: ticker ('USDT', 'BTC') or RGB id ('rgb:…')." },
      from_layer:    { type: 'string', description: "Optional: 'BTC_LN', 'RGB_LN', 'BTC_SPARK'. Derived from the asset when omitted." },
      to_layer:      { type: 'string', description: "Optional: 'RGB_LN', 'BTC_LN', 'BTC_SPARK'. Derived from the asset when omitted." },
      from_amount:   { type: 'number', description: 'Amount to SELL in display units (e.g. 0.001 BTC, 10 USDT).' },
      to_amount:     { type: 'number', description: 'Amount to BUY in display units (e.g. 10 USDT).' },
    },
    ['from_asset_id', 'to_asset_id']),

  t('market',
    'kaleidoswap_get_nodeinfo',
    "Get info about the maker's Lightning node — pubkey, host, port, connect URI. Useful before opening a channel or when the user wants to see the counterparty. No args."),

  // ─── atomic (the trust-minimised swap chain — used by the recipe) ───────
  t('atomic',
    'kaleidoswap_atomic_init',
    'Start an atomic swap from a fresh quote. SPEND: confirmation-gated. Pass the quote rfq_id, both asset ids and the quote legs\' amount_raw values unchanged. Returns swapstring, payment_hash and access_token (keep it for status).',
    {
      rfq_id:          { type: 'string', description: 'rfq_id from kaleidoswap_get_quote.' },
      from_asset_id:   { type: 'string', description: 'from_asset.asset_id from the quote.' },
      from_amount_raw: { type: 'integer', description: 'from_asset.amount_raw from the quote, unchanged.' },
      to_asset_id:     { type: 'string', description: 'to_asset.asset_id from the quote.' },
      to_amount_raw:   { type: 'integer', description: 'to_asset.amount_raw from the quote, unchanged.' },
    },
    ['rfq_id', 'from_asset_id', 'from_amount_raw', 'to_asset_id', 'to_amount_raw'],
    /* spend */ true),

  t('atomic',
    'kaleidoswap_atomic_execute',
    'Confirm the swap after rln_atomic_taker whitelisted the swapstring. SPEND: confirmation-gated. taker_pubkey is the pubkey from rln_get_node_info.',
    {
      swapstring:   { type: 'string', description: 'swapstring from kaleidoswap_atomic_init.' },
      taker_pubkey: { type: 'string', description: 'Node pubkey from rln_get_node_info.' },
      payment_hash: { type: 'string', description: 'payment_hash from kaleidoswap_atomic_init.' },
    },
    ['swapstring', 'taker_pubkey', 'payment_hash'],
    /* spend */ true),

  t('atomic',
    'kaleidoswap_atomic_status',
    'Poll an atomic swap by payment_hash: Waiting → Pending → Succeeded | Expired | Failed.',
    {
      payment_hash: { type: 'string', description: 'payment_hash from kaleidoswap_atomic_init.' },
      access_token: { type: 'string', description: 'access_token from kaleidoswap_atomic_init, when the host needs it.' },
    },
    ['payment_hash']),

  // ─── liquidity (buy a NEW channel pre-loaded with an asset — onboarding) ──
  t('liquidity',
    'kaleidoswap_lsp_quote_asset_channel',
    'Quote buying a NEW Lightning channel pre-loaded with an RGB asset (e.g. USDT, XAUT) from the maker LSP. This is the onboarding path for a user who has on-chain BTC but no channel yet and wants to hold an asset — they pay once to receive a channel that already holds the asset. Read-only: returns an rfq_id, the BTC price in sats, the channel/setup fee, the total to pay, and when the quote expires. Re-quote rather than reusing a stale rfq_id.',
    {
      asset:        { type: 'string', description: 'RGB asset to receive in the channel, e.g. "USDT" or "XAUT".' },
      asset_amount: { type: 'number', description: 'How much of the asset to load into the channel, in the asset’s display units (e.g. 100 for 100 USDT).' },
    },
    ['asset', 'asset_amount']),

  t('liquidity',
    'kaleidoswap_lsp_create_asset_channel',
    'Order a new Lightning channel pre-loaded with an RGB asset from the maker LSP, using a fresh rfq_id from kaleidoswap_lsp_quote_asset_channel. SPEND: confirmation-gated. Returns an order id and the payment (on-chain address or Lightning invoice) the user pays to open the channel; the channel opens only after the payment confirms. Poll kaleidoswap_lsp_get_order to track it.',
    {
      asset:        { type: 'string', description: 'RGB asset to receive (must match the quote).' },
      asset_amount: { type: 'number', description: 'Asset amount in display units (must match the quote).' },
      rfq_id:       { type: 'string', description: 'The rfq_id from kaleidoswap_lsp_quote_asset_channel (must still be valid).' },
    },
    ['asset', 'asset_amount', 'rfq_id'],
    /* spend */ true),
];

/** All tool names that move funds (confirmation-gated). */
export const KALEIDOSWAP_SPEND_TOOLS: Set<string> = new Set(
  KALEIDOSWAP_TOOLS.filter((t) => t.spend).map((t) => t.name),
);

/** Quick lookup. */
export function isKaleidoswapSpendTool(name: string): boolean {
  return KALEIDOSWAP_SPEND_TOOLS.has(name);
}

/** Quick lookup. */
export function getKaleidoswapTool(name: string): KaleidoswapToolDef | undefined {
  return KALEIDOSWAP_TOOLS.find((t) => t.name === name);
}

/** Pick the contract tools for the given groups (all by default). */
export function kaleidoswapTools(
  opts: { groups?: KaleidoswapGroup[] } = {},
): KaleidoswapToolDef[] {
  if (!opts.groups) return [...KALEIDOSWAP_TOOLS];
  const groups = new Set(opts.groups);
  return KALEIDOSWAP_TOOLS.filter((x) => groups.has(x.group));
}

const isBtc = (asset: unknown) => typeof asset === 'string' && /^(btc|sats?)$/i.test(asset.trim());

/**
 * Map kaleido-mcp argument names onto the pre-0.9 contract names (and back), so
 * one call shape works on every surface and older host handlers keep working.
 * Canonical names win; legacy names are only filled in when absent. The legacy
 * quote `amount` is sats for BTC and display units otherwise.
 */
export function normalizeKaleidoswapArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const a: Record<string, unknown> = { ...args };
  const alias = (canonical: string, legacy: string) => {
    if (a[canonical] == null && a[legacy] != null) a[canonical] = a[legacy];
    if (a[legacy] == null && a[canonical] != null) a[legacy] = a[canonical];
  };
  if (name === 'kaleidoswap_get_quote') {
    if (a.from_asset_id == null && a.from_asset != null) a.from_asset_id = a.from_asset;
    if (a.to_asset_id == null && a.to_asset != null) a.to_asset_id = a.to_asset;
    if (a.from_amount == null && a.to_amount == null && a.amount != null) {
      const side = a.amount_side === 'to' || a.side === 'buy' ? 'to' : 'from';
      const asset = side === 'to' ? a.to_asset_id : a.from_asset_id;
      const display = isBtc(asset) ? Number(a.amount) / 1e8 : Number(a.amount);
      a[side === 'to' ? 'to_amount' : 'from_amount'] = display;
    }
    a.from_asset ??= a.from_asset_id;
    a.to_asset ??= a.to_asset_id;
    if (a.amount == null) {
      const toSide = a.from_amount == null && a.to_amount != null;
      const display = Number(toSide ? a.to_amount : a.from_amount);
      const asset = toSide ? a.to_asset_id : a.from_asset_id;
      if (Number.isFinite(display)) a.amount = isBtc(asset) ? Math.round(display * 1e8) : display;
      if (toSide) a.amount_side = 'to';
    }
  } else if (name === 'kaleidoswap_atomic_init') {
    alias('rfq_id', 'quote_id');
  } else if (name === 'kaleidoswap_atomic_execute' || name === 'kaleidoswap_atomic_status') {
    alias('payment_hash', 'atomic_id');
  }
  return a;
}

/** A handler bound to one contract tool. Args validated by JSON schema upstream. */
export type KaleidoswapHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface BindKaleidoswapOptions {
  /** Restrict the surface to a subset (e.g. read-only on eval). */
  groups?: KaleidoswapGroup[];
  /** Skip tools that have no handler instead of throwing (default false). */
  allowMissing?: boolean;
  /** ToolSource id for the registry (default 'kaleidoswap'). */
  id?: string;
}

/**
 * Bind contract tools to in-process handlers → an InProcessToolSource.
 *
 * The host is responsible for the actual transport (HTTP/WDK/CLI/MCP) — this
 * function is a pure shape adapter that preserves names, descriptions,
 * parameter schemas, and the spend gate.
 *
 *   const source = bindKaleidoswapTools({
 *     kaleidoswap_get_quote: async (args) => makerSdk.quote(args),
 *     // …
 *   });
 *   tools.register(source);
 */
export function bindKaleidoswapTools(
  handlers: Record<string, KaleidoswapHandler>,
  opts: BindKaleidoswapOptions = {},
): InProcessToolSource {
  const defs = kaleidoswapTools(opts);
  const bound: InProcessTool[] = [];
  for (const def of defs) {
    const handler = handlers[def.name];
    if (!handler) {
      if (opts.allowMissing) continue;
      throw new Error(`bindKaleidoswapTools: no handler for "${def.name}"`);
    }
    bound.push({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      requiresConfirmation: def.requiresConfirmation,
      handler: (args) => handler(normalizeKaleidoswapArgs(def.name, args)),
    });
  }
  return new InProcessToolSource(opts.id ?? 'kaleidoswap', bound);
}
