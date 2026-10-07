/**
 * Canonical multi-L2 wallet tool contract — the single source of truth for
 * KaleidoMind's wallet tools (names + JSON schemas + spend flags).
 *
 * Every surface implements THESE EXACT tools, only the transport differs:
 *   - mobile  → in-process handlers over the WDK adapters (`bindWalletTools`)
 *   - desktop → kaleido-mcp (tools namespaced per layer) + a `kaleido` CLI
 *   - eval    → stub handlers
 *
 * Because the schemas are identical everywhere, skills are portable and the
 * model comparison is honest. Tools are namespaced per layer (`spark_*`,
 * `rln_*`, `arkade_*`, `liquid_*`); cross-cutting router/helpers are unprefixed.
 *
 * Spend tools (move funds) carry `spend: true` → `requiresConfirmation: true`,
 * so the Engine always pauses for the host's confirm gate before executing.
 *
 * Pure data — no deps, RN-safe.
 */

import type { ToolDef } from '../types.js';
import { InProcessToolSource } from '../tools/in-process.js';
import type { InProcessTool } from '../tools/in-process.js';

export type WalletLayer = 'spark' | 'rln' | 'arkade' | 'liquid' | 'core';

export interface WalletToolDef extends ToolDef {
  /** Which L2 (or 'core' for cross-cutting router/helpers). */
  layer: WalletLayer;
  /** Moves funds → confirmation-gated. */
  spend?: boolean;
}

type Props = Record<string, { type: string; description?: string; enum?: string[] }>;

function t(
  layer: WalletLayer,
  name: string,
  description: string,
  properties: Props = {},
  required: string[] = [],
  spend = false,
): WalletToolDef {
  return {
    layer,
    name,
    description,
    spend,
    requiresConfirmation: spend,
    parameters: { type: 'object', properties, required },
  };
}

const sats = { type: 'number', description: 'Amount in satoshis' } as const;
const asset = { type: 'string', description: "Asset ticker, e.g. 'USDT', 'XAUT', 'BTC'" } as const;

/** The full contract. Keep descriptions terse — small models read every word. */
export const WALLET_TOOLS: WalletToolDef[] = [
  // ── Spark ──────────────────────────────────────────────────────────────
  t('spark', 'spark_get_balance', 'Get the Spark wallet balances — BTC sats AND every Spark-native token (e.g. USDB). Returns `{ total: <sats>, tokens: [{ address, balance, symbol?, decimals?, available_to_send? }], connected, layer, network }`. Use for ANY "balance / how much / what do I have on Spark" question — call it fresh every time, balances change. The `tokens` array surfaces ALL Spark-native tokens the wallet holds, so you do NOT need to call flashnet_get_balance separately for that (flashnet_get_balance is the AMM-client view of the same wallet and returns the same numbers). For RGB asset balances (USDT, XAUT) use the RLN tools — RGB assets are NOT on Spark.'),
  // The user-facing "Spark address" — an off-chain Spark identity (sparkrt1…/
  // spark1…). For OFF-CHAIN peer transfers WITHIN Spark. NOT a Bitcoin
  // on-chain address. Use spark_get_onchain_address for the on-chain deposit
  // path; use spark_create_invoice for a Lightning invoice.
  t('spark', 'spark_get_address', 'Get the user\'s Spark address (sparkrt1…/spark1…) — an OFF-CHAIN Spark identity for receiving Spark-to-Spark transfers. NOT a Bitcoin on-chain address (does not start with bc1/tb1/bcrt1) and NOT a Lightning invoice. For "an on-chain address to deposit BTC into Spark" use spark_get_onchain_address. For a Lightning invoice use spark_create_invoice.'),
  // Real on-chain Bitcoin address used to deposit BTC FROM mainnet INTO the
  // Spark wallet. The SDK calls this a "static deposit address" — bc1…/tb1…/
  // bcrt1…. The opposite of spark_get_address.
  t('spark', 'spark_get_onchain_address', 'Get a real Bitcoin ON-CHAIN address (bc1…/tb1…/bcrt1…) for depositing BTC from the Bitcoin L1 into the Spark wallet. Use ANY time the user asks for "an on-chain address", "deposit address", "Bitcoin address to fund Spark", "where do I send my on-chain BTC". This is NOT the Spark identity (spark_get_address) and NOT a Lightning invoice (spark_create_invoice).'),
  t('spark', 'spark_create_invoice', 'Create a Spark Lightning invoice (BOLT11) to receive BTC over Lightning. Returns an invoice string the user can share. Use when the user asks for "an invoice", "a lightning invoice", "pay me", or names an amount they want received. NOT an address.', { amount_sats: sats }),
  // Explicit Lightning-invoice payer. BOLT11 invoices encode the amount, so
  // `amount_sats` is optional and only used for amount-less ("any-amount")
  // invoices. Prefer this over `spark_send` when the destination is a BOLT11
  // invoice — it removes ambiguity for small models and gives the cross-skill
  // bitrefill flow a single, unambiguous target.
  t('spark', 'spark_pay_invoice',
    'Pay a Lightning (BOLT11) invoice from the Spark wallet. The invoice already encodes the amount; pass amount_sats ONLY for amount-less invoices. Use this for any BOLT11 destination (Bitrefill, contact, raw invoice).',
    { invoice: { type: 'string', description: 'BOLT11 Lightning invoice (lnbc…/lntb…/lnbcrt…).' }, amount_sats: { type: 'number', description: 'Required ONLY when the invoice has no amount; omit otherwise.' } },
    ['invoice'],
    /* spend */ true),
  t('spark', 'spark_send',
    'Send BTC from Spark to an on-chain address (bc1…/tb1…). For BOLT11 invoices, prefer spark_pay_invoice.',
    { amount_sats: sats, to: { type: 'string', description: 'On-chain Bitcoin address.' } },
    ['amount_sats', 'to'],
    /* spend */ true),

  // ── RLN / RGB ──────────────────────────────────────────────────────────
  t('rln', 'rln_get_balances', 'Get RLN node balances (BTC + RGB assets).'),
  t('rln', 'rln_get_node_info', 'Get RLN node status and sync state.'),
  t('rln', 'rln_list_channels', 'List the RLN node Lightning channels.'),
  t('rln', 'rln_create_ln_invoice', 'Create a Lightning (BTC) invoice on the RLN node.', { amount_sats: sats }),
  t('rln', 'rln_create_rgb_invoice', 'Create an RGB invoice to receive an asset on-chain. Returns the invoice string to share with the payer.', {
    asset_id: { type: 'string', description: "RGB asset id ('rgb:…'); in-app wallets also accept a ticker. Omit for any asset." },
    amount: { type: 'number', description: 'Expected amount in display units (e.g. 10 for 10 USDT)' },
    duration_seconds: { type: 'number', description: 'Invoice expiry (default 86400)' },
  }),
  t('rln', 'rln_pay_invoice', 'Pay a Lightning invoice from the RLN node.', { invoice: { type: 'string' } }, ['invoice'], true),
  t('rln', 'rln_send_asset', 'Send an RGB asset to the recipient of an RGB invoice.', {
    asset_id: { type: 'string', description: "RGB asset id ('rgb:…') from rln_list_assets; in-app wallets also accept a ticker." },
    recipient_id: { type: 'string', description: 'Recipient from the RGB invoice: its utxob:/wvout: part, or the whole invoice.' },
    amount: { type: 'number', description: 'Amount in display units (e.g. 10 for 10 USDT)' },
    fee_rate: { type: 'number', description: 'sat/vbyte (default 3)' },
  }, ['asset_id', 'recipient_id', 'amount'], true),
  t('rln', 'rln_list_assets', 'List every RGB asset on the RLN node with its balance (asset_id, ticker, name, precision, balance {settled, future, spendable, offchain_outbound, offchain_inbound} in raw units = display × 10^precision). Answers "what do I hold" in one call.'),
  t('rln', 'rln_get_asset_balance', 'Get the balance of ONE RGB asset by asset_id (settled, future, spendable, off-chain). rln_list_assets already includes every balance.', { asset_id: { type: 'string', description: "RGB asset id, e.g. 'rgb:2JEUOrsc-…'" } }, ['asset_id']),
  t('rln', 'rln_refresh_transfers', 'Refresh pending RGB transfers so balances and transfer status are up to date.'),
  t('rln', 'rln_get_address', 'Get an on-chain BTC address of the RLN node for deposits.'),
  t('rln', 'rln_send_btc', 'Send on-chain BTC from the RLN node.', { address: { type: 'string', description: 'Destination Bitcoin address' }, amount_sat: { type: 'number', description: 'Amount in satoshis' }, fee_rate: { type: 'number', description: 'sat/vbyte (default 3)' } }, ['address', 'amount_sat'], true),
  t('rln', 'rln_list_payments', 'List recent Lightning payments (sent and received) on the RLN node.', { limit: { type: 'number', description: 'Max payments (default 20)' } }),
  t('rln', 'rln_connect_peer', 'Connect the RLN node to a Lightning peer.', { peer_pubkey_and_addr: { type: 'string', description: 'pubkey@host:port' } }, ['peer_pubkey_and_addr']),
  t('rln', 'rln_open_channel', 'Open a Lightning channel, optionally allocating an RGB asset to it.', {
    peer_pubkey_and_addr: { type: 'string', description: 'pubkey@host:port' },
    capacity_sat: { type: 'number', description: 'Channel capacity in satoshis' },
    push_msat: { type: 'number', description: 'Millisatoshis pushed to the peer (default 0)' },
    asset_id: { type: 'string', description: 'RGB asset id to allocate' },
    asset_amount: { type: 'number', description: 'RGB asset amount to allocate' },
    is_public: { type: 'boolean', description: 'Announce the channel (default false)' },
  }, ['peer_pubkey_and_addr', 'capacity_sat'], true),
  t('rln', 'rln_close_channel', 'Close a Lightning channel (force only for an unresponsive peer).', { channel_id: { type: 'string' }, peer_pubkey: { type: 'string' }, force: { type: 'boolean', description: 'Unilateral close (default false)' } }, ['channel_id', 'peer_pubkey'], true),
  t('rln', 'rln_get_channel_id', 'Resolve a temporary_channel_id from rln_open_channel to the final channel_id.', { temporary_channel_id: { type: 'string' } }, ['temporary_channel_id']),
  t('rln', 'rln_atomic_taker', 'Whitelist a maker swap on the node (taker side). Pass the swapstring from kaleidoswap_atomic_init, before kaleidoswap_atomic_execute.', { swapstring: { type: 'string' } }, ['swapstring'], true),
  t('rln', 'rln_list_swaps', 'List atomic swaps on the RLN node (maker and taker sides).'),
  t('rln', 'rln_get_swap', 'Get an atomic swap by payment_hash.', { payment_hash: { type: 'string' }, taker: { type: 'boolean', description: 'Taker-side swap' } }, ['payment_hash']),
  t('rln', 'rln_list_transfers', 'List RGB transfers for one asset (issuance, sends, receives) with their status — use to check if an RGB invoice was paid.', { asset_id: { type: 'string', description: 'RGB asset id (in-app wallets also accept a ticker)' } }, ['asset_id']),
  // Issuance + UTXO prep spend on-chain BTC and are irreversible → gated like any spend.
  t('rln', 'rln_create_utxos', 'Create colorable UTXOs on the RLN node — needed before issuing or receiving RGB assets on a fresh node.', {
    num: { type: 'number', description: 'How many UTXOs (default 5)' },
    size: { type: 'number', description: 'Size of each UTXO in sats (default: node decides)' },
    up_to: { type: 'boolean', description: 'Only top up to `num` free UTXOs (default false)' },
    fee_rate: { type: 'number', description: 'sat/vbyte (default 1)' },
  }, [], true),
  t('rln', 'rln_issue_asset', 'Issue a NEW RGB asset owned by this node (e.g. an event ticket or loyalty token).', {
    schema: { type: 'string', enum: ['NIA', 'CFA', 'UDA'], description: 'NIA = token (default), CFA = collectible, UDA = unique/NFT' },
    name: { type: 'string', description: 'Asset name, e.g. "Hackathon Ticket"' },
    ticker: { type: 'string', description: 'Uppercase ticker, e.g. "TICKET". Required for NIA and UDA' },
    amount: { type: 'number', description: 'Total supply in display units. Required for NIA and CFA; UDA is always 1' },
    precision: { type: 'number', description: 'Decimal places (default 0)' },
    details: { type: 'string', description: 'Optional description (CFA and UDA)' },
  }, ['name'], true),

  // ── Arkade ─────────────────────────────────────────────────────────────
  t('arkade', 'arkade_get_balance', 'Get the Arkade wallet balance.'),
  t('arkade', 'arkade_get_address', 'Get an Arkade address to receive funds.'),
  t('arkade', 'arkade_send', 'Send BTC from Arkade to a recipient.', { amount_sats: sats, to: { type: 'string' } }, ['amount_sats', 'to'], true),

  // ── Liquid (later) ─────────────────────────────────────────────────────
  t('liquid', 'liquid_get_balance', 'Get the Liquid wallet balance (L-BTC + assets).'),
  t('liquid', 'liquid_create_invoice', 'Create a Liquid invoice/address to receive (L-BTC or L-USDt).', { asset, amount: { type: 'number' } }),
  t('liquid', 'liquid_send', 'Send a Liquid asset (L-BTC or L-USDt) to a recipient.', { asset, amount: { type: 'number' }, to: { type: 'string' } }, ['asset', 'amount', 'to'], true),

  // ── Core: router + helpers ─────────────────────────────────────────────
  t('core', 'get_balances', 'Get balances across all layers (or one layer).', { layer: { type: 'string', enum: ['spark', 'rln', 'arkade', 'liquid'], description: 'Optional: a single layer' } }),
  t('core', 'resolve_contact', 'Resolve a contact name to a Lightning address / Nostr / preferred rail.', { name: { type: 'string', description: 'Contact name, e.g. "bob"' } }, ['name']),
  t('core', 'get_price', 'Get the current price of an asset, optionally in a fiat currency.', { asset, vs_currency: { type: 'string', description: "Quote currency, e.g. 'usd', 'eur' (default usd)" } }, ['asset']),
  t('core', 'fiat_to_sats', 'Convert a fiat amount to satoshis at the current rate.', { amount: { type: 'number' }, currency: { type: 'string', description: "Fiat code, e.g. 'EUR'" } }, ['amount', 'currency']),
  t('core', 'get_swap_quote', 'Quote a swap between two assets.', { from_asset: asset, to_asset: asset, amount: { type: 'number' } }, ['from_asset', 'to_asset', 'amount']),
  t('core', 'execute_swap', 'Execute a previously quoted swap.', { quote_id: { type: 'string' }, from_asset: asset, to_asset: asset, amount: { type: 'number' } }, [], true),
  // The high-level entry a skill prefers — picks the rail for the asset, or uses `layer`.
  t('core', 'send_payment', 'Send a payment, automatically choosing the best layer for the asset (or use `layer`).', { asset, amount_sats: sats, to: { type: 'string', description: 'Contact, address, or invoice' }, layer: { type: 'string', enum: ['spark', 'rln', 'arkade', 'liquid'] } }, ['to'], true),
  // High-level receive — picks the right invoice/address tool for the asset/layer.
  t('core', 'create_invoice', 'Create an invoice or address to receive funds, choosing the rail for the asset (or use `layer`). Omit amount for an any-amount invoice.', { asset, amount: { type: 'number', description: 'Amount (sats for BTC, asset units otherwise) — optional' }, layer: { type: 'string', enum: ['spark', 'rln', 'arkade', 'liquid'] } }),
];

// ── Selectors ───────────────────────────────────────────────────────────────

export const WALLET_LAYERS: WalletLayer[] = ['spark', 'rln', 'arkade', 'liquid', 'core'];

/** Names of all spend (fund-moving) tools — these are confirmation-gated. */
export const SPEND_TOOLS: ReadonlySet<string> = new Set(WALLET_TOOLS.filter((x) => x.spend).map((x) => x.name));

export function isSpendTool(name: string): boolean {
  return SPEND_TOOLS.has(name);
}

export function getWalletTool(name: string): WalletToolDef | undefined {
  return WALLET_TOOLS.find((x) => x.name === name);
}

/** Pick the contract tools for the given layers (core helpers included by default). */
export function walletTools(opts: { layers?: WalletLayer[]; includeCore?: boolean } = {}): WalletToolDef[] {
  const layers = new Set(opts.layers ?? (['spark', 'rln', 'arkade', 'liquid'] as WalletLayer[]));
  if (opts.includeCore !== false) layers.add('core');
  return WALLET_TOOLS.filter((x) => layers.has(x.layer));
}

/** Strip to plain ToolDefs (drop the layer/spend metadata). */
export function toToolDefs(tools: WalletToolDef[]): ToolDef[] {
  return tools.map(({ name, description, parameters, requiresConfirmation }) => ({ name, description, parameters, requiresConfirmation }));
}

/**
 * Map kaleido-mcp argument names onto the pre-0.9 contract names (and back), so
 * one call shape works on every surface and older host handlers keep working.
 */
export function normalizeWalletArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const a: Record<string, unknown> = { ...args };
  const alias = (canonical: string, legacy: string) => {
    if (a[canonical] == null && a[legacy] != null) a[canonical] = a[legacy];
    if (a[legacy] == null && a[canonical] != null) a[legacy] = a[canonical];
  };
  if (name === 'rln_send_asset') {
    alias('asset_id', 'asset');
    alias('recipient_id', 'to');
  } else if (name === 'rln_create_rgb_invoice') {
    alias('asset_id', 'asset');
  } else if (name === 'get_price') {
    alias('vs_currency', 'fiat');
  }
  return a;
}

/** A handler bound to one contract tool. */
export type WalletHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface BindWalletOptions {
  layers?: WalletLayer[];
  includeCore?: boolean;
  /** Skip tools that have no handler instead of throwing (default false). */
  allowMissing?: boolean;
  id?: string;
}

/**
 * Bind contract tools to in-process handlers → an InProcessToolSource. The
 * mobile (and eval) binding: pass a map of `{ toolName: handler }` and you get a
 * ToolSource implementing the canonical schemas with spend flags preserved.
 */
export function bindWalletTools(handlers: Record<string, WalletHandler>, opts: BindWalletOptions = {}): InProcessToolSource {
  const tools = walletTools(opts);
  const bound: InProcessTool[] = [];
  for (const def of tools) {
    const handler = handlers[def.name];
    if (!handler) {
      if (opts.allowMissing) continue;
      throw new Error(`bindWalletTools: no handler for "${def.name}"`);
    }
    bound.push({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      requiresConfirmation: def.requiresConfirmation,
      handler: (args) => handler(normalizeWalletArgs(def.name, args)),
    });
  }
  return new InProcessToolSource(opts.id ?? 'wallet', bound);
}
