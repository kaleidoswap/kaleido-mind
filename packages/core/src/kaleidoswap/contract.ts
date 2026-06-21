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
 * model comparison is honest. Tools are grouped (`market`, `orders`, `atomic`,
 * `liquidity`) so a host can expose a read-only subset for sandbox/eval modes.
 *
 * Spend tools (place an order, init/execute an atomic swap) carry
 * `spend: true` → `requiresConfirmation: true`, so the Engine always pauses
 * for the host's confirm gate before executing.
 *
 * Pure data — no deps, no fetch, RN-safe.
 */

import type { ToolDef } from '../types.js';
import { InProcessToolSource } from '../tools/in-process.js';
import type { InProcessTool } from '../tools/in-process.js';

/** Functional grouping for selective binding (e.g. read-only sandbox). */
export type KaleidoswapGroup = 'market' | 'orders' | 'atomic' | 'liquidity';

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
    'Get an executable quote for swapping a specific amount on one pair. Returns a quote id (use it with place_order or atomic_init), the expected receive amount, fees, slippage, and how long the quote is valid for. Re-quote rather than reusing a stale id.',
    {
      from_asset: { type: 'string', description: 'Asset to spend, e.g. "BTC" or "USDT".' },
      to_asset:   { type: 'string', description: 'Asset to receive, e.g. "USDT" or "BTC".' },
      amount:     { type: 'number', description: 'Amount of from_asset to swap. BTC is in satoshis; RGB assets use their asset-defined precision.' },
      side:       { type: 'string', enum: ['buy', 'sell'], description: 'Default "sell" (you sell from_asset). Use "buy" only when from_asset is the quote currency you spend to acquire to_asset.' },
    },
    ['from_asset', 'to_asset', 'amount']),

  t('market',
    'kaleidoswap_get_nodeinfo',
    "Get info about the maker's Lightning node — pubkey, host, port, connect URI. Useful before opening a channel or when the user wants to see the counterparty. No args."),

  // ─── orders (orderbook / market-order flow) ─────────────────────────────
  t('orders',
    'kaleidoswap_place_order',
    'Place an order using an executable quote. Returns order_id + access_token (save the token — required for get_order_status). SPEND: the host pauses for user confirmation before the maker is called. Use only after kaleidoswap_get_quote and only when the user has explicitly approved the amount + destination.',
    {
      quote_id: { type: 'string', description: 'The quote id returned by kaleidoswap_get_quote (must still be valid).' },
    },
    ['quote_id'],
    /* spend */ true),

  t('orders',
    'kaleidoswap_get_order_status',
    'Check the status of an order by id — pending / settling / completed / failed. Poll this after place_order until the order settles. Requires the access_token returned by place_order for authenticated orders.',
    {
      order_id: { type: 'string', description: 'The order id returned by kaleidoswap_place_order.' },
      access_token: { type: 'string', description: 'The per-order access token returned by kaleidoswap_place_order. Required for status checks on the order.' },
    },
    ['order_id', 'access_token']),

  t('orders',
    'kaleidoswap_get_order_history',
    "Get the user's recent KaleidoSwap orders for context (last N, paginated). Read-only.",
    {
      limit:  { type: 'number', description: 'Max rows (default 20, max 100).' },
      cursor: { type: 'string', description: 'Pagination cursor from a previous call.' },
    }),

  // ─── atomic (the trust-minimised swap chain — used by the recipe) ───────
  t('atomic',
    'kaleidoswap_atomic_init',
    "Initialise an atomic swap from a quote. Requires the receiver's RGB/LN invoice so the maker can lock the outgoing leg. SPEND: confirmation-gated. Returns the maker's invoice for the user to pay and an atomic id to track.",
    {
      quote_id:        { type: 'string', description: 'The quote id from kaleidoswap_get_quote.' },
      receive_invoice: { type: 'string', description: "The user's RGB or Lightning invoice for to_asset, created on the user's own node." },
    },
    ['quote_id', 'receive_invoice'],
    /* spend */ true),

  t('atomic',
    'kaleidoswap_atomic_execute',
    "Tell the maker to release the receive leg now that the user has paid the maker's invoice. SPEND: confirmation-gated (committing the swap). Returns an updated atomic status.",
    {
      atomic_id: { type: 'string', description: 'The atomic id from kaleidoswap_atomic_init.' },
    },
    ['atomic_id'],
    /* spend */ true),

  t('atomic',
    'kaleidoswap_atomic_status',
    'Poll the status of an atomic swap — pending_payment / paid / settling / completed / failed / expired. Use this in a loop after execute until it terminates.',
    {
      atomic_id: { type: 'string', description: 'The atomic id from kaleidoswap_atomic_init.' },
    },
    ['atomic_id']),

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
 *     kaleidoswap_place_order: async ({ quote_id }) => makerSdk.placeOrder({ quoteId: quote_id }),
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
      handler,
    });
  }
  return new InProcessToolSource(opts.id ?? 'kaleidoswap', bound);
}
