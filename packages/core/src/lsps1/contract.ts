/**
 * Canonical LSPS1 tool contract — Lightning Service Provider channel orders.
 *
 * LSPS1 is a transport-agnostic protocol for buying inbound channel liquidity
 * from a Lightning Service Provider. The maker happens to implement it, but a
 * different LSP could too — so the tool names are LSP-agnostic (`lsp_*`),
 * not `kaleidoswap_*`. The host's binder decides which LSP they reach.
 *
 * Every surface implements THESE EXACT tools, only the transport differs:
 *   - mobile  → in-process handlers over the WDK LSP adapter
 *   - desktop → HTTP / MCP / CLI handlers
 *   - eval    → stub handlers
 *
 * `lsp_create_order` is a spend → confirmation-gated.
 *
 * Pure data — no deps, no fetch, RN-safe.
 */

import type { ToolDef } from '../types.js';
import { InProcessToolSource } from '../tools/in-process.js';
import type { InProcessTool } from '../tools/in-process.js';

export interface Lsps1ToolDef extends ToolDef {
  /** Moves funds → confirmation-gated. */
  spend?: boolean;
}

type Props = Record<string, { type: string; description?: string; enum?: string[] }>;

function t(name: string, description: string, properties: Props = {}, required: string[] = [], spend = false): Lsps1ToolDef {
  return {
    name,
    description,
    spend,
    requiresConfirmation: spend,
    parameters: { type: 'object', properties, required },
  };
}

/**
 * The canonical LSPS1 tool list — agent-facing schemas. Each host's binder
 * translates these args into the LSP's request body (LSPS1 JSON-RPC, the
 * KaleidoSwap maker's REST routes, MCP, or a WDK adapter call).
 */
export const LSPS1_TOOLS: Lsps1ToolDef[] = [
  t('lsp_get_info',
    "Get the LSP's capabilities: minimum/maximum channel size, supported expiries, fee structure, accepted payment options. Use this before estimating or ordering a channel. No args."),

  t('lsp_get_network_info',
    "Get the LSP's Lightning network info: pubkey, host, port, connect URI. Useful to display the counterparty or pre-connect a peer. No args."),

  t('lsp_estimate_fees',
    "Estimate the channel-order fee BEFORE committing. Returns setup_fee, capacity_fee, duration_fee, total_fee (all in sats). Re-estimate rather than reusing a stale value.",
    {
      lsp_balance_sat:       { type: 'number', description: "Sats the LSP commits on their side (inbound capacity for the user)." },
      client_balance_sat:    { type: 'number', description: "Sats the user pre-funds into the channel (push amount). Default 0." },
      channel_expiry_blocks: { type: 'number', description: 'Lease duration in blocks. Default 4320 (~30 days). Maker maximum is typically 20160 (~140 days).' },
      // RGB asset channels (optional):
      asset_id:              { type: 'string', description: 'For RGB asset channels — the asset to provision liquidity for.' },
      lsp_asset_amount:      { type: 'number', description: 'Asset units the LSP commits (RGB channels only).' },
      client_asset_amount:   { type: 'number', description: 'Asset units the user pre-funds (RGB channels only). Requires rfq_id.' },
      rfq_id:                { type: 'string', description: 'Quote id from kaleidoswap_get_quote — required when client_asset_amount > 0.' },
      token:                 { type: 'string', description: 'Optional discount/affiliate token.' },
    },
    ['lsp_balance_sat', 'client_balance_sat', 'channel_expiry_blocks']),

  t('lsp_create_order',
    "Create a channel order. SPEND: confirmation-gated. Returns order_id + access_token + a payment.bolt11.invoice the user pays to lock the order. The channel opens only after payment.",
    {
      client_pubkey:                  { type: 'string', description: "User's Lightning node pubkey — the LSP opens the channel TO this node. Get it from rln_get_node_info." },
      lsp_balance_sat:                { type: 'number', description: "Sats the LSP commits on their side (inbound capacity for the user)." },
      client_balance_sat:             { type: 'number', description: "Sats the user pre-funds. Default 0." },
      required_channel_confirmations: { type: 'number', description: 'Number of confs the user wants before considering the channel usable. Default 1.' },
      funding_confirms_within_blocks: { type: 'number', description: 'Max blocks within which funding must confirm. Default 6.' },
      channel_expiry_blocks:          { type: 'number', description: 'Lease duration in blocks. Default 4320 (~30 days).' },
      announce_channel:               { type: 'boolean', description: 'Public (true) or unannounced (false). Default true.' },
      refund_onchain_address:         { type: 'string', description: 'Optional on-chain refund address if the LSP cannot open the channel.' },
      // RGB asset channels (optional):
      asset_id:                       { type: 'string', description: 'For RGB asset channels.' },
      lsp_asset_amount:               { type: 'number', description: 'Asset units the LSP commits.' },
      client_asset_amount:            { type: 'number', description: 'Asset units the user pre-funds.' },
      rfq_id:                         { type: 'string', description: 'Required when client_asset_amount > 0.' },
      token:                          { type: 'string', description: 'Optional discount/affiliate token.' },
      email:                          { type: 'string', description: 'Optional contact for order updates.' },
    },
    ['client_pubkey', 'lsp_balance_sat'],
    /* spend */ true),

  t('lsp_get_order',
    'Check the status of an LSPS1 order. order_state progresses CREATED → CHANNEL_OPENING → COMPLETED (or FAILED). ALWAYS pass BOTH the order_id and the access_token from lsp_create_order (the access_token is required for order status).',
    {
      order_id:     { type: 'string', description: 'The order id from lsp_create_order.' },
      access_token: { type: 'string', description: 'The per-order access token returned by lsp_create_order. Required for non-admin reads.' },
    },
    ['order_id', 'access_token']),
];

/** All LSPS1 tool names that move funds (confirmation-gated). */
export const LSPS1_SPEND_TOOLS: Set<string> = new Set(
  LSPS1_TOOLS.filter((t) => t.spend).map((t) => t.name),
);

export function isLsps1SpendTool(name: string): boolean {
  return LSPS1_SPEND_TOOLS.has(name);
}

export function getLsps1Tool(name: string): Lsps1ToolDef | undefined {
  return LSPS1_TOOLS.find((t) => t.name === name);
}

/** A handler bound to one LSPS1 tool. */
export type Lsps1Handler = (args: Record<string, unknown>) => Promise<unknown>;

export interface BindLsps1Options {
  /** Skip tools without a handler instead of throwing (default false). */
  allowMissing?: boolean;
  /** ToolSource id for the registry (default 'lsps1'). */
  id?: string;
}

/**
 * Bind LSPS1 contract tools to in-process handlers → an InProcessToolSource.
 *
 *   const source = bindLsps1Tools({
 *     lsp_get_info:        async () => makerLsp.getInfo(),
 *     lsp_estimate_fees:   async (args) => makerLsp.estimateFees(args),
 *     lsp_create_order:    async (args) => makerLsp.createOrder(args),
 *     lsp_get_order:       async ({ order_id }) => makerLsp.getOrder(order_id),
 *     lsp_get_network_info:async () => makerLsp.networkInfo(),
 *   });
 *   tools.register(source);
 */
export function bindLsps1Tools(handlers: Record<string, Lsps1Handler>, opts: BindLsps1Options = {}): InProcessToolSource {
  const bound: InProcessTool[] = [];
  for (const def of LSPS1_TOOLS) {
    const handler = handlers[def.name];
    if (!handler) {
      if (opts.allowMissing) continue;
      throw new Error(`bindLsps1Tools: no handler for "${def.name}"`);
    }
    bound.push({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      requiresConfirmation: def.requiresConfirmation,
      handler,
    });
  }
  return new InProcessToolSource(opts.id ?? 'lsps1', bound);
}
