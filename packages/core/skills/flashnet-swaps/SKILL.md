---
name: flashnet-swaps
description: "Swap BTC and Spark tokens (e.g. USDB) on Flashnet, the Spark-native AMM, from the in-app Spark wallet: list pools, simulate, execute."
tools: flashnet_list_pools, flashnet_get_pool, flashnet_simulate_swap, flashnet_execute_swap, flashnet_get_balance, spark_get_balance
requires-tools: flashnet_simulate_swap
triggers: flashnet, usdb, amm, pool, pools, spark swap, btc to usdb, usdb to btc
metadata:
  author: kaleidoswap
  version: "1.1.0"
  venue: flashnet
---
# Flashnet swaps

The Spark wallet is the swap account. Flashnet trades BTC against Spark tokens
only; RGB assets (USDT, XAUT) trade on KaleidoSwap (`kaleido-trading`).

## Do
- Start with `flashnet_list_pools`; take `pool_id` and the asset addresses
  from its result. Never invent a pool or address.
- `amount_in` and `min_amount_out` are strings in the smallest unit
  (sats for BTC). `asset_in` is what the user spends.
- Always `flashnet_simulate_swap` first; show `amount_out` and
  `price_impact_pct`; ask before going on if impact is above 1%.
- `min_amount_out = floor(amount_out × (1 − max_slippage_bps / 10000))`,
  default `max_slippage_bps` 50. Then `flashnet_execute_swap`
  (confirm-gated).
- "Slippage exceeded": re-simulate once, then ask the user.

## Examples
- "Pools for BTC/USDB" → `flashnet_list_pools {"asset_a":"BTC","asset_b":"USDB"}`
- "What would 100k sats get me in USDB?" → `flashnet_simulate_swap {"pool_id":"<pool_id>","asset_in_address":"<BTC address>","asset_out_address":"<USDB address>","amount_in":"100000"}`
- "Do it" → `flashnet_execute_swap {"pool_id":"<pool_id>","asset_in_address":"<BTC address>","asset_out_address":"<USDB address>","amount_in":"100000","min_amount_out":"<computed>","max_slippage_bps":50}`
