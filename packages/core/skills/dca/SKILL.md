---
name: dca
description: "Dollar-cost-average a fixed budget into a target asset on a schedule. Reads the live quote and (when allowed) buys a small fixed slice via an atomic swap, respecting per-run allocation and risk limits. Triggers when the user mentions DCA, recurring buys, or averaging in — and is the skill a user-created DCA loop runs."
tools: rln_get_balances, kaleidoswap_get_quote, kaleidoswap_atomic_init, kaleidoswap_atomic_execute, kaleidoswap_atomic_status, get_price
triggers: dca, dollar cost average, recurring buy, average in, accumulate, stack
metadata:
  author: kaleidoswap
  version: "0.1.0"
---

# Dollar-cost averaging

Buy a fixed, small slice of a target asset each run. Boring on purpose: same
size, every interval, regardless of price.

## Critical rules — these override everything else

- **Fixed slice only.** The per-run budget is the task's `allocation` — never
  exceed it, never "catch up" by buying extra after a missed run.
- **Respect `dry_run`.** When true, quote and report what you *would* buy; do NOT
  execute.
- **Respect risk + reserve.** A DCA buy is a spend; it passes through the host's
  risk gate. Never breach the BTC reserve or the max single-spend limit.

## Each run

1. **Check funds.** `rln_get_balances` — is there enough BTC for one slice plus
   the reserve? If not, return `action: "skip"` with the reason.
2. **Quote.** `kaleidoswap_get_quote(BTC, <asset>, <slice>)`. Read the
   `to_amount_display` / `fee_display` strings verbatim — no arithmetic.
3. **Execute** (only when `dry_run` is false and within limits): the atomic swap
   recipe drives `kaleidoswap_atomic_init` → `_execute`; then poll
   `kaleidoswap_atomic_status`.

## Scheduled (background) runs

Return STRICT JSON only:

```
{"task":"<task id>","timestamp":"<ISO8601>","action":"buy|skip","dry_run":<bool>,"reason":"<why>","details":{"asset":"<asset>","slice":"<n>","received":"<display>","fee":"<display>"}}
```

## Don'ts

- Don't vary the slice size or try to time the market — that's not DCA.
- Don't buy when funds are below the reserve — `skip` instead.
- Don't execute when `dry_run` is true.
- Don't invent a quote — only the current `kaleidoswap_get_quote` result is real.
