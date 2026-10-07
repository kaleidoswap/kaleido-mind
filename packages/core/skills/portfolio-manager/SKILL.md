---
name: portfolio-manager
description: "Portfolio across BTC, USDT and XAUT: holdings and allocation, drift versus targets, rebalancing and recurring DCA buys through KaleidoSwap atomic swaps. Runs the scheduled rebalance, DCA and daily summary tasks."
tools: rln_get_balances, rln_list_assets, get_price, get_market_data, kaleidoswap_get_pairs, kaleidoswap_get_quote, kaleidoswap_atomic_init, rln_atomic_taker, rln_get_node_info, kaleidoswap_atomic_execute, kaleidoswap_atomic_status
requires-tools: kaleidoswap_get_quote
triggers: portfolio, allocation, rebalance, drift, target, weighting, holdings, dca, dollar cost average, recurring buy, average in, accumulate, daily summary
metadata:
  author: kaleidoswap
  version: "0.2.0"
---
# Portfolio manager

Holdings: BTC from `rln_get_balances`, RGB assets (with balances, raw units ÷
10^precision) from `rln_list_assets`. Prices from `get_price`. Targets, budget,
reserve and `dry_run` come from the task parameters or the user.

## Do
- Value each holding in one currency, compute weight and drift = weight −
  target. Inside the threshold → no trade.
- Rebalance: one swap per run, the smallest that brings the worst drift back
  inside the band, from the over-weight asset into the most under-weight one.
- DCA: buy the fixed slice every run; never catch up missed runs; skip when
  BTC minus the slice would fall below the reserve.
- Quote with `kaleidoswap_get_quote` (display units). Execute only when
  `dry_run` is false and within limits, via the atomic chain in the
  `kaleido-trading` skill.
- Scheduled runs: `action` is `rebalance`, `buy`, `skip` or `noop`; put the
  explanation in `reason`.

## Examples
- "Show my allocation" → `rln_get_balances {}` then `rln_list_assets {}` then `get_price {"asset":"BTC"}`
- "DCA 0.0002 BTC into USDT" → `kaleidoswap_get_quote {"from_asset_id":"BTC","to_asset_id":"USDT","from_amount":0.0002}`
- "Sell 50 USDT back to BTC" → `kaleidoswap_get_quote {"from_asset_id":"USDT","to_asset_id":"BTC","from_amount":50}`
