---
name: flashnet-swaps
description: "Swap between BTC and Spark tokens (e.g. USDB) using Flashnet — a Spark-native AMM. Run by quoting `flashnet_simulate_swap` first, then `flashnet_execute_swap` on confirmation. Pairs with the spark-wallet skill: the same Spark wallet that holds your BTC is what signs the swap. Triggers on swap/exchange/convert/trade phrasings involving BTC + a Spark token, or explicit mention of Flashnet."
tools: flashnet_list_pools, flashnet_get_pool, flashnet_simulate_swap, flashnet_execute_swap, flashnet_get_balance, spark_get_balance, spark_get_address, get_price, fiat_to_sats
triggers: flashnet, swap, exchange, convert, trade, usdb, amm, pool, liquidity, btc to usdb, usdb to btc, spark swap
metadata:
  author: kaleidoswap
  version: "1.0.0"
  venue: flashnet
---

# Flashnet swaps

Flashnet is a Spark-native AMM. The user's Spark wallet IS the swap account —
there's no separate exchange balance. A swap takes one asset from the wallet,
sends it through a pool, and returns the other asset to the same wallet, in
seconds. Two pool curve types exist (constant-product and V3 concentrated
liquidity) — the model doesn't need to care; the pool id is enough.

## What Flashnet trades (and what it does NOT)

**Flashnet trades:**
- **BTC** ↔ **Spark-native tokens**. The canonical example is **USDB**.
- Whatever pools `flashnet_list_pools` returns — that list is the
  authoritative answer to "what can I trade here?".

**Flashnet does NOT trade:**
- **RGB assets** (USDT, XAUT, …). RGB assets live on the RLN layer and
  trade via the **KaleidoSwap maker** (`kaleido-trading` skill), not here.
  USDT on Flashnet does not exist — never offer it.
- Assets the user holds on Arkade, on-chain BTC reserves, or any external
  chain. The trade-account is the Spark wallet.

If the user asks for an asset you can't see in `flashnet_list_pools`, tell
them so plainly and (if it's a known RGB asset like USDT/XAUT) point them
at the kaleido-trading skill rather than inventing a Flashnet pool.

## Critical rules (read first)

1. **Never invent a pool id, asset address, or amount.** Every `pool_id`,
   `asset_in_address`, `asset_out_address`, `amount_in` you pass MUST come
   from `flashnet_list_pools` / `flashnet_simulate_swap` / a tool-returned
   value in the CURRENT turn — never from history, never guessed.
2. **Always simulate before executing.** Call `flashnet_simulate_swap` to
   get `amount_out` + `price_impact_pct`, show the user the rate in plain
   English, get explicit confirmation, then call `flashnet_execute_swap`.
   The host fires one extra confirmation gate on execute — that's the
   safety net, not the primary one.
3. **Compute `min_amount_out` yourself.** Never pass the simulated
   `amount_out` directly to execute. The standard formula is
   `min_amount_out = floor(amount_out × (1 − max_slippage_bps / 10000))`.
   Default `max_slippage_bps: 50` (0.5%). Use 100 for volatile pairs or
   high price impact (>0.5%); ask the user before going higher than 1%.
4. **Smallest units, as strings.** `amount_in` / `min_amount_out` are in
   the asset's smallest unit (sats for BTC; the token's smallest decimal
   place for tokens). Pass them as JSON strings so BigInt-sized values
   survive round-trip. e.g. `amount_in: "100000"` for 100k sats, NOT
   `amount_in: 100000`.
5. **High price impact = stop and ask.** If
   `simulate_swap.price_impact_pct > 1.0`, surface it explicitly:
   "This trade would move the price by 1.7%. Continue?" Don't auto-execute
   anything with >2% impact without a clear user yes.

## Happy-path playbook

For a typical "swap 100k sats to USDB":

1. **`flashnet_list_pools({ asset_a: <BTC>, asset_b: <USDB> })`** — find a
   pool. Pick the first result (already sorted by TVL desc). Save its
   `pool_id`, `asset_a_address`, `asset_b_address`.

   - If the user named a specific asset by *symbol* (e.g. "USDB"), the host
     fills in the token address based on the active Spark network. The
     model just passes the symbol or whatever address the prior tool
     returned.

2. **`flashnet_simulate_swap({ pool_id, asset_in_address, asset_out_address, amount_in })`**
   — get `amount_out`, `execution_price`, `price_impact_pct`,
   `fee_paid_asset_in`. Show the user one short line:

   `Swap 100,000 sats → ~497,500 USDB (0.5% pool fee, 0.18% price impact).
    Proceed?`

3. **Compute `min_amount_out`** from the simulated `amount_out` and the
   chosen slippage tolerance (default 0.5% / 50 bps). Don't trust the
   simulated value as-is.

4. **`flashnet_execute_swap({ pool_id, asset_in_address, asset_out_address,
   amount_in, min_amount_out, max_slippage_bps })`** — SPEND, gated. On
   success returns the swap `request_id` and the actual `amount_out`.
   Surface the realised amount on a single line.

## When to use which tool

| Tool | Use when |
|---|---|
| `flashnet_list_pools` | First step of any swap; or when the user asks "what pools exist for X/Y". |
| `flashnet_get_pool` | User wants pool depth / current price / TVL before swapping. |
| `flashnet_simulate_swap` | EVERY swap, before execute. Also for "what would I get if I swapped 5k sats?" — read-only quote. |
| `flashnet_execute_swap` | After user confirms the simulated quote. Confirmation-gated. |
| `flashnet_get_balance` | Pre-swap balance check, or "what do I have on Spark/Flashnet". (Reads from the same wallet `spark_get_balance` reads — they are not separate accounts.) |

## Cross-skill flow with spark-wallet

The Spark wallet and Flashnet share the same on-device account. Common
chains:

- **Pre-swap balance check.** `spark_get_balance` (or
  `flashnet_get_balance`) → confirm the user has enough sats → quote →
  execute.
- **Deposit then swap.** User has on-chain BTC → `spark_get_address` to
  receive into Spark → wait for confirmation (the user does that
  externally) → swap.
- **Swap then pay invoice.** User has USDB but needs to pay a BOLT11
  invoice → swap USDB → BTC (this skill) → `spark_pay_invoice` (the
  spark-wallet skill) → done.

## Failure handling

Tool errors arrive as `Error.message`. Common ones:

- **`Insufficient balance`** — the wallet doesn't hold enough
  `asset_in`. Surface the deficit. Suggest depositing or swapping less.
- **`Slippage exceeded` / `min_amount_out not met`** — the pool moved
  between simulate and execute. Re-simulate and try again (the host can
  do this; don't loop more than 2× automatically — ask the user after
  that).
- **`Pool not found` / `Asset not allowed`** — pool id stale or wrong
  network. Re-list pools.
- **Authentication / connection errors** — the Spark wallet isn't
  initialized. Say so plainly; don't fake a result.

## Reply style

- Quote line: amount in, amount out, fee, price impact — all on one line.
- After execute: one-line result with realised amount and tx id.
- Never paste a multi-line JSON of the simulate/execute response.
- Don't echo `amount_in` / `min_amount_out` raw numbers in subsequent
  turns; the model isn't a ledger.
