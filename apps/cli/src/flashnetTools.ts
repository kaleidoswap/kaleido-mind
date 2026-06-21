/**
 * Flashnet CLI adapter — Spark-native AMM swaps (BTC ⇄ Spark tokens).
 *
 * Bound on top of the same SparkWallet that the spark_* tools use. The
 * FlashnetClient drives every API call; this file only normalizes args/results
 * for the canonical `flashnet_*` contract.
 *
 * Asset addresses:
 *   - BTC is a constant pubkey known to Flashnet (`BTC_ASSET_PUBKEY`).
 *   - Tokens are Spark Bech32m token identifiers (or hex; the client coerces).
 *
 * The model passes BTC as either a literal pubkey or the case-insensitive
 * ticker "BTC" / "btc" — the host substitutes the constant for the user.
 * Similarly, "USDB" / "usdb" maps to the network's USDB token address when the
 * Flashnet SDK exposes one.
 *
 * No mocks. If the SDK fails to load, the binder throws on first use.
 */

import {
  bindFlashnetTools,
  type FlashnetHandler,
  type InProcessToolSource,
} from '@kaleidorg/mind';
import { getSparkWallet } from './sparkWallet.js';

/** Flashnet SDK network names: SparkNetworkType is uppercase. */
type SparkNetworkType = 'MAINNET' | 'REGTEST' | 'TESTNET' | 'SIGNET' | 'LOCAL';
type ClientEnvironment = 'mainnet' | 'regtest' | 'testnet' | 'signet' | 'local';

function asClientEnv(n: SparkNetworkType): ClientEnvironment {
  return n.toLowerCase() as ClientEnvironment;
}

/** Best-effort symbol → address resolver. Pure host-side normalization. */
/** Does this string already look like a raw asset address (hex / bech32m)? */
function looksLikeAddress(s: string): boolean {
  return /^[0-9a-f]{40,}$/i.test(s) || /^[a-z0-9]{1,12}1[a-z0-9]{20,}$/i.test(s);
}

/**
 * Strict resolver for swap legs — the asset MUST resolve to a real address.
 * BTC → the constant; a known ticker → its address; a raw address → itself.
 * An unknown short symbol THROWS with guidance (never silently pass a ticker
 * the backend can't match — that produces opaque errors and risks a wrong
 * swap). The skill is told to call flashnet_list_pools to discover addresses.
 */
function normalizeAssetAddress(
  input: unknown,
  btcConst: string | undefined,
  symbolToAddr: Record<string, string>,
): string {
  const s = String(input ?? '').trim();
  if (!s) throw new Error('asset address required');
  const upper = s.toUpperCase();
  if (upper === 'BTC' || upper === 'SATS' || upper === 'BITCOIN') {
    if (!btcConst) throw new Error('BTC asset pubkey unavailable in this SDK build');
    return btcConst;
  }
  if (symbolToAddr[upper]) return symbolToAddr[upper];
  if (looksLikeAddress(s)) return s;
  throw new Error(
    `Unknown asset "${s}". On this network it has no known ticker. Call ` +
    `flashnet_list_pools to find the pool and use the asset address it returns ` +
    `(or set KALEIDO_FLASHNET_TOKEN_${upper}=<address>).`,
  );
}

/** Soft resolver for the list_pools FILTER — unknown symbol → undefined (omit
 *  the filter) instead of throwing, so discovery still returns pools. */
function softResolveAsset(
  input: unknown,
  btcConst: string | undefined,
  symbolToAddr: Record<string, string>,
): string | undefined {
  try {
    return normalizeAssetAddress(input, btcConst, symbolToAddr);
  } catch {
    return undefined;
  }
}

function jsonSafe<T>(value: T): T {
  // JSON.stringify with a replacer that flattens BigInt — the SDK returns
  // bigint reserves and balances all over the place.
  return JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v))) as T;
}

/**
 * Build an InProcessToolSource implementing the canonical flashnet_* contract.
 * Lazily constructs a FlashnetClient on first use and caches it.
 */
export async function buildFlashnetToolSource(opts: { log?: (m: string) => void } = {}): Promise<InProcessToolSource> {
  const log = opts.log ?? (() => {});
  const { wallet, network } = await getSparkWallet();

  const sdk = await import('@flashnet/sdk');
  const FlashnetClient: any = (sdk as any).FlashnetClient;
  if (!FlashnetClient) throw new Error('@flashnet/sdk: FlashnetClient not exported');

  // Build the client. New-style config: sparkNetworkType + clientEnvironment.
  // For "regtest" both align; "MAINNET" → "mainnet" client env.
  const sparkNetworkType: SparkNetworkType = network;
  const clientEnvironment: ClientEnvironment = asClientEnv(network);
  const client = new FlashnetClient(wallet, {
    sparkNetworkType,
    clientEnvironment,
    autoAuthenticate: true,
  });
  await client.initialize();
  log(`flashnet client ready · network=${network}`);

  // BTC constant comes from the SDK; fall back to undefined if it isn't exported.
  const btcConst: string | undefined = (sdk as any).BTC_ASSET_PUBKEY ?? (sdk as any).BTC_ASSET_ADDRESS ?? undefined;

  // Symbol ↔ address maps, used to resolve tickers ("USDB") to addresses and
  // to label pool rows. Three sources, later wins:
  //   1. BTC constant.
  //   2. Flashnet getAllowedAssets() — gives asset_name where the network has
  //      one (mainnet/testnet). On regtest these are often null.
  //   3. Env overrides KALEIDO_FLASHNET_TOKEN_<SYM>=<addr> (and the legacy
  //      KALEIDO_FLASHNET_USDB_ADDRESS) — the only way to name tokens on
  //      regtest, where the network exposes no symbols.
  const symbolToAddr: Record<string, string> = {};
  const addrToSymbol: Record<string, string> = {};
  const bind = (sym: string, addr: string) => {
    if (!sym || !addr) return;
    symbolToAddr[sym.toUpperCase()] = addr;
    if (!addrToSymbol[addr]) addrToSymbol[addr] = sym.toUpperCase();
  };
  if (btcConst) bind('BTC', btcConst);
  try {
    const allowed: Array<{ asset_identifier: string; asset_name: string | null }> =
      await client.getAllowedAssets();
    for (const it of allowed ?? []) {
      if (it.asset_name) bind(it.asset_name, it.asset_identifier);
    }
  } catch (e) {
    log(`getAllowedAssets failed (symbols unavailable): ${(e as Error)?.message ?? e}`);
  }
  for (const [k, v] of Object.entries(process.env)) {
    const m = k.match(/^KALEIDO_FLASHNET_TOKEN_([A-Z0-9]+)$/);
    if (m && m[1] && v) bind(m[1], v);
  }
  if (process.env.KALEIDO_FLASHNET_USDB_ADDRESS) bind('USDB', process.env.KALEIDO_FLASHNET_USDB_ADDRESS);
  log(`flashnet symbols: ${Object.keys(symbolToAddr).join(', ') || '(none — use addresses)'}`);

  const handlers: Record<string, FlashnetHandler> = {
    flashnet_list_pools: async (a) => {
      const limit = Math.min(50, Math.max(1, Number(a.limit ?? 10)));
      const base: any = { limit };
      if (a.sort) base.sort = String(a.sort);
      // Soft-resolve filters: an unknown ticker becomes "no filter" rather than
      // an error, so discovery still returns pools.
      const aAddr = a.asset_a ? softResolveAsset(a.asset_a, btcConst, symbolToAddr) : undefined;
      const bAddr = a.asset_b ? softResolveAsset(a.asset_b, btcConst, symbolToAddr) : undefined;

      let r = await client.listPools({
        ...base,
        ...(aAddr ? { assetAAddress: aAddr } : {}),
        ...(bAddr ? { assetBAddress: bAddr } : {}),
      });
      // Pools store a pair in ONE order. If a two-sided filter found nothing,
      // retry with the sides swapped (e.g. asked BTC/USDB but the pool is
      // stored USDB/BTC). This is why an earlier BTC-on-side-A filter missed
      // every pool — BTC is almost always asset_b.
      if ((!r?.pools || r.pools.length === 0) && aAddr && bAddr) {
        r = await client.listPools({ ...base, assetAAddress: bAddr, assetBAddress: aAddr });
      }

      const label = (addr: string | undefined) => (addr && addrToSymbol[addr]) || undefined;
      const pools = (r?.pools ?? []).slice(0, limit).map((p: any) => ({
        pool_id: p.lpPublicKey ?? p.poolId ?? p.id,
        asset_a_address: p.assetAAddress,
        asset_a_symbol: label(p.assetAAddress),
        asset_b_address: p.assetBAddress,
        asset_b_symbol: label(p.assetBAddress),
        curve_type: p.curveType ?? p.type,
        tvl_asset_b: p.tvlAssetB,
        volume24h_asset_b: p.volume24hAssetB,
        price_a_in_b: p.currentPriceAInB,
        fee_bps: (p.lpFeeBps ?? 0) + (p.hostFeeBps ?? 0),
        host_name: p.hostName,
      }));
      return jsonSafe({ pools, total_count: r?.totalCount ?? pools.length });
    },

    flashnet_get_pool: async (a) => {
      const r = await client.getPoolDetails(String(a.pool_id));
      return jsonSafe({
        pool_id: a.pool_id,
        asset_a_address: r?.assetAAddress,
        asset_b_address: r?.assetBAddress,
        asset_a_reserve: r?.assetAReserve,
        asset_b_reserve: r?.assetBReserve,
        current_price_a_in_b: r?.currentPriceAInB,
        tvl_asset_b: r?.tvlAssetB,
        volume24h_asset_b: r?.volume24hAssetB,
        fee_bps: (r?.lpFeeBps ?? 0) + (r?.hostFeeBps ?? 0),
        host_name: r?.hostName,
      });
    },

    flashnet_simulate_swap: async (a) => {
      const assetIn = normalizeAssetAddress(a.asset_in_address, btcConst, symbolToAddr);
      const assetOut = normalizeAssetAddress(a.asset_out_address, btcConst, symbolToAddr);
      const r = await client.simulateSwap({
        poolId: String(a.pool_id),
        assetInAddress: assetIn,
        assetOutAddress: assetOut,
        amountIn: String(a.amount_in),
      });
      return jsonSafe({
        amount_out: r?.amountOut,
        execution_price: r?.executionPrice,
        price_impact_pct: r?.priceImpactPct,
        fee_paid_asset_in: r?.feePaidAssetIn,
        warning: r?.warningMessage,
        asset_in_address: assetIn,
        asset_out_address: assetOut,
        pool_id: a.pool_id,
        amount_in: String(a.amount_in),
      });
    },

    flashnet_execute_swap: async (a) => {
      const assetIn = normalizeAssetAddress(a.asset_in_address, btcConst, symbolToAddr);
      const assetOut = normalizeAssetAddress(a.asset_out_address, btcConst, symbolToAddr);
      const r: any = await client.executeSwap({
        poolId: String(a.pool_id),
        assetInAddress: assetIn,
        assetOutAddress: assetOut,
        amountIn: String(a.amount_in),
        minAmountOut: String(a.min_amount_out),
        maxSlippageBps: Math.max(0, Math.min(5000, Number(a.max_slippage_bps ?? 50))),
      });
      return jsonSafe({
        accepted: r?.accepted,
        request_id: r?.requestId,
        amount_out: r?.amountOut,
        execution_price: r?.executionPrice,
        fee_amount: r?.feeAmount,
        outbound_transfer_id: r?.outboundTransferId,
        refunded: r?.refundedAmount ? { asset: r.refundedAssetAddress, amount: r.refundedAmount, transfer_id: r.refundTransferId } : undefined,
        error: r?.error,
      });
    },

    flashnet_get_balance: async () => {
      const b: any = await client.getBalance();
      // Convert Map<string, TokenBalance> → array.
      const tokens: any[] = [];
      const tb = b?.tokenBalances;
      if (tb && typeof tb.forEach === 'function') {
        tb.forEach((v: any, k: string) => {
          tokens.push({
            address: k,
            balance: typeof v?.balance === 'bigint' ? v.balance.toString() : v?.balance,
            available_to_send: typeof v?.availableToSendBalance === 'bigint' ? v.availableToSendBalance.toString() : v?.availableToSendBalance,
            symbol: v?.tokenInfo?.tokenSymbol,
            decimals: v?.tokenInfo?.tokenDecimals,
          });
        });
      }
      const btc = typeof b?.balance === 'bigint' ? Number(b.balance) : Number(b?.balance ?? 0);
      return jsonSafe({ btc_sats: btc, tokens, network });
    },
  };

  return bindFlashnetTools(handlers);
}
