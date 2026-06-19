---
name: portfolio-manager
description: "Keep a BTC / USDT / XAUT portfolio near its target allocation. Read live balances and prices, detect drift versus targets, and (when allowed) rebalance via an atomic swap on KaleidoSwap. Triggers when the user asks to rebalance, check allocation, review the portfolio, or optimize holdings — and is the skill the scheduled 'rebalance' loop runs."
tools: rln_get_balances, rln_list_assets, kaleidoswap_get_pairs, kaleidoswap_get_quote, kaleidoswap_atomic_init, kaleidoswap_atomic_execute, kaleidoswap_atomic_status, get_price, get_market_data
triggers: rebalance, allocation, portfolio, drift, optimize, target, weighting, holdings
metadata:
  author: kaleidoswap
  version: "0.1.0"
---

# Portfolio manager

Keep the holdings near their target weights across **BTC**, **USDT**, and
**XAUT**. You fetch everything live — never assume a balance, price, or target.

## Critical rules — these override everything else

- **Read before you act.** Get balances (`rln_get_balances`) and prices
  (`get_price`) every run. Never reuse a number from a previous turn.
- **Respect `dry_run`.** When `dry_run` is true you describe the rebalance you
  *would* make — you do NOT call `kaleidoswap_atomic_init`/`_execute`. This is
  non-negotiable.
- **Respect fund safety.** Never propose a swap that breaches the BTC reserve or
  stop-loss floor passed in the task parameters. The host's risk gate is the
  final word, but don't even suggest a breach.
- **Below-minimum drift = do nothing.** If every asset is within the drift
  threshold, say so and stop. Churn is a cost, not a feature.

## How to think about a rebalance

1. **Snapshot.** `rln_get_balances` → BTC sats + each RGB asset (raw units).
2. **Value it.** Convert each holding to a common denomination using
   `get_price`. Do NOT do arithmetic free-hand on raw RGB units — use the
   display fields the tools return; only convert sats↔USD with the live BTC
   price.
3. **Compare to targets.** Targets come in the task parameters (e.g.
   `BTC 70 / USDT 20 / XAUT 10`). Compute each asset's current weight and its
   drift = current − target.
4. **Decide.** If the largest drift exceeds the threshold, the over-weight asset
   sells into the most under-weight asset. One swap per run — smallest trade
   that brings the worst drift back inside the band.
5. **Quote.** `kaleidoswap_get_quote(from, to, amount)` for that single leg.
6. **Execute** (only when `dry_run` is false and the size is within limits): the
   atomic swap recipe drives `kaleidoswap_atomic_init` → `_execute`; then poll
   `kaleidoswap_atomic_status`.

## Asset codes (canonical)

`BTC` (satoshis), `USDT` (not `USD`), `XAUT` (not `XAU`/gold).

## Scheduled (background) runs

When run by the `rebalance` loop, after deciding, return STRICT JSON only:

```
{"task":"rebalance","timestamp":"<ISO8601>","action":"rebalance|noop","dry_run":<bool>,"reason":"<why>","details":{"from":"<asset>","to":"<asset>","amount":"<n>","drift":{}}}
```

`action` is `noop` when within band. Put the human explanation in `reason`.

## Don'ts

- Don't invent prices, quotes, or balances — call the tool.
- Don't rebalance on noise — honor the drift threshold.
- Don't place more than one swap per run.
- Don't breach the reserve / stop-loss, ever.
- Don't execute anything when `dry_run` is true.
