---
name: submarine-swaps
description: "Pay a Lightning invoice from Liquid funds (L-USDT or L-BTC) through a KaleidoSwap submarine swap, and follow its status."
tools: kaleidoswap_submarine_pairs, kaleidoswap_submarine_create, kaleidoswap_submarine_fund, kaleidoswap_submarine_status
requires-tools: kaleidoswap_submarine_create
triggers: l-usdt, liquid usdt, usdt on liquid, l-btc, liquid bitcoin, submarine, submarine swap, pay invoice with liquid
metadata:
  author: kaleidoswap
  version: "0.2.0"
---
# Submarine swaps

The user locks Liquid funds; the maker pays the Lightning invoice, then claims
the lockup. If the maker can't pay, the lockup is refundable. Plain "USDT" is
RGB USDT (`kaleido-trading`), not this skill.

## Do
1. `kaleidoswap_submarine_create` (`invoice`, `from_asset`) — `from_asset` is
   `L-USDT` (default) or `L-BTC`. Returns `swap_id`, `expected_amount`
   (smallest unit, 8 decimals for both) and fees. Nothing moves yet.
2. Tell the user the amount and ask to confirm.
3. `kaleidoswap_submarine_fund` (`swap_id` only; confirm-gated).
4. `kaleidoswap_submarine_status` (`swap_id`) — `transaction.claimed` means paid;
   `failed: true` on a funded swap needs a refund: quote the `refund` field.
- Limits and fees: `kaleidoswap_submarine_pairs {}`.

## Examples
- "Pay lntbs10u1p… with L-USDT" → `kaleidoswap_submarine_create {"invoice":"lntbs10u1p…","from_asset":"L-USDT"}`
- "Did swap sub1 go through?" → `kaleidoswap_submarine_status {"swap_id":"sub1"}`
- "What can pay Lightning from Liquid?" → `kaleidoswap_submarine_pairs {}`
