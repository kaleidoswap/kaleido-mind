/**
 * Canonical Flashnet tool contract — AMM swaps on Spark.
 *
 * Flashnet is a Spark-native AMM (constant-product + V3 concentrated-liquidity
 * pools). The agent surface is small and intent-aligned:
 *
 *   flashnet_list_pools       — discover pools by asset pair (read)
 *   flashnet_get_pool         — pool details + reserves (read)
 *   flashnet_simulate_swap    — quote a swap, no funds move (read)
 *   flashnet_execute_swap     — SPEND, confirmation-gated (the swap itself)
 *   flashnet_get_balance      — Spark wallet balance (BTC + tokens) as the
 *                               AMM client sees it
 *
 * The model picks a pool, simulates to see the rate/output, optionally shows
 * the user the quote, and then executes. The host's `FlashnetClient` (built
 * over a `SparkWallet`) does the actual signing.
 *
 * Asset addresses on Flashnet:
 *   - BTC is a constant pubkey: `BTC_ASSET_PUBKEY` per network.
 *   - Tokens are Spark Bech32m token identifiers (or hex; the client coerces).
 *
 * Pure data — no deps, RN-safe.
 */

import type { ToolDef } from '../types.js';
import { InProcessToolSource } from '../tools/in-process.js';
import type { InProcessTool } from '../tools/in-process.js';

export interface FlashnetToolDef extends ToolDef {
  /** Moves funds → confirmation-gated. */
  spend?: boolean;
}

type Props = Record<
  string,
  { type: string; description?: string; enum?: string[]; items?: unknown }
>;

function t(
  name: string,
  description: string,
  properties: Props = {},
  required: string[] = [],
  spend = false,
): FlashnetToolDef {
  return {
    name,
    description,
    spend,
    requiresConfirmation: spend,
    parameters: { type: 'object', properties, required },
  };
}

/** Canonical Flashnet tools. */
export const FLASHNET_TOOLS: FlashnetToolDef[] = [
  t(
    'flashnet_list_pools',
    "List Flashnet AMM pools. Filter by asset pair to find a venue for a swap (e.g. asset_a=BTC, asset_b=<USDB address> → pools that swap between them). Returns pools sorted by TVL by default. Use this BEFORE simulate_swap to pick a `pool_id`.",
    {
      asset_a: { type: 'string', description: 'OPTIONAL — first asset address (BTC pubkey or Spark token id). Filters pools.' },
      asset_b: { type: 'string', description: 'OPTIONAL — second asset address. Filters pools containing both assets.' },
      sort: { type: 'string', description: 'OPTIONAL — sort order. Default TVL_DESC.', enum: ['TVL_DESC', 'TVL_ASC', 'VOLUME24H_DESC', 'VOLUME24H_ASC', 'CREATED_AT_DESC', 'CREATED_AT_ASC'] },
      limit: { type: 'number', description: 'OPTIONAL — max pools (1–50, default 10).' },
    },
  ),

  t(
    'flashnet_get_pool',
    "Get a single pool's details — reserves, fees, current price, TVL. Use after flashnet_list_pools when the user wants to inspect a pool before swapping.",
    {
      pool_id: { type: 'string', description: 'Pool id (LP pubkey) from flashnet_list_pools.' },
    },
    ['pool_id'],
  ),

  t(
    'flashnet_simulate_swap',
    "Simulate a swap WITHOUT executing — returns `amount_out`, `execution_price`, `price_impact_pct`, `fee_paid`. Read-only. Use this to quote the user before they confirm. The `amount_in` is in smallest units of `asset_in` (sats for BTC, smallest unit of the token).",
    {
      pool_id:           { type: 'string', description: 'Pool id from flashnet_list_pools.' },
      asset_in_address:  { type: 'string', description: 'Address of the asset the user is selling (BTC pubkey or Spark token id).' },
      asset_out_address: { type: 'string', description: 'Address of the asset the user is buying.' },
      amount_in:         { type: 'string', description: 'Amount to swap, in smallest units of asset_in. Strings (BigInt-safe). e.g. "100000" for 100k sats.' },
    },
    ['pool_id', 'asset_in_address', 'asset_out_address', 'amount_in'],
  ),

  t(
    'flashnet_execute_swap',
    "SPEND: confirmation-gated. Execute a swap quoted by flashnet_simulate_swap. `min_amount_out` and `max_slippage_bps` cap the worst-case fill (basis points: 100 = 1%, 50 = 0.5%). Returns the swap request id and the amount actually received.",
    {
      pool_id:           { type: 'string', description: 'Pool id from flashnet_list_pools.' },
      asset_in_address:  { type: 'string' },
      asset_out_address: { type: 'string' },
      amount_in:         { type: 'string', description: 'Amount to swap, smallest units.' },
      min_amount_out:    { type: 'string', description: 'Minimum acceptable output, smallest units. Calculate from simulate_swap.amount_out × (1 − max_slippage_bps/10000) and pass that — never trust the simulated value as-is.' },
      max_slippage_bps:  { type: 'number', description: 'Maximum slippage in basis points (default 50 = 0.5%). 100 = 1%, 500 = 5%.' },
    },
    ['pool_id', 'asset_in_address', 'asset_out_address', 'amount_in', 'min_amount_out'],
    /* spend */ true,
  ),

  t(
    'flashnet_get_balance',
    "Get the Spark wallet's BTC + token balances as the Flashnet client sees them. Useful to verify the user has enough of asset_in before quoting or executing a swap. Returns `{ btc_sats, tokens: [{ address, balance, symbol?, decimals? }] }`.",
  ),
];

/** All Flashnet tool names that move funds (confirmation-gated). */
export const FLASHNET_SPEND_TOOLS: Set<string> = new Set(
  FLASHNET_TOOLS.filter((t) => t.spend).map((t) => t.name),
);

export function isFlashnetSpendTool(name: string): boolean {
  return FLASHNET_SPEND_TOOLS.has(name);
}

export function getFlashnetTool(name: string): FlashnetToolDef | undefined {
  return FLASHNET_TOOLS.find((t) => t.name === name);
}

/** A handler bound to one Flashnet tool. */
export type FlashnetHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface BindFlashnetOptions {
  /** Skip tools without a handler instead of throwing (default false). */
  allowMissing?: boolean;
  /** ToolSource id for the registry (default 'flashnet'). */
  id?: string;
}

/**
 * Bind Flashnet contract tools to in-process handlers → an InProcessToolSource.
 *
 *   const source = bindFlashnetTools({
 *     flashnet_list_pools:     async (a) => client.listPools(a),
 *     flashnet_get_pool:       async ({ pool_id }) => client.getPoolDetails(pool_id),
 *     flashnet_simulate_swap:  async (a) => client.simulateSwap(a),
 *     flashnet_execute_swap:   async (a) => client.executeSwap(a),
 *     flashnet_get_balance:    async () => client.getBalance(),
 *   });
 */
export function bindFlashnetTools(
  handlers: Record<string, FlashnetHandler>,
  opts: BindFlashnetOptions = {},
): InProcessToolSource {
  const bound: InProcessTool[] = [];
  for (const def of FLASHNET_TOOLS) {
    const handler = handlers[def.name];
    if (!handler) {
      if (opts.allowMissing) continue;
      throw new Error(`bindFlashnetTools: no handler for "${def.name}"`);
    }
    bound.push({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      requiresConfirmation: def.requiresConfirmation,
      handler,
    });
  }
  return new InProcessToolSource(opts.id ?? 'flashnet', bound);
}
