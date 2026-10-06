---
name: submarine-swaps
description: "Pay a Lightning invoice from Liquid funds (L-USDT or L-BTC) through a KaleidoSwap submarine swap on the /v2 maker, and follow its status. Triggers when the user wants to pay a Lightning invoice with Liquid USDT / L-USDT / L-BTC, asks what Liquid assets can pay Lightning, or asks about a submarine swap."
tools: kaleidoswap_submarine_pairs, kaleidoswap_submarine_create, kaleidoswap_submarine_fund, kaleidoswap_submarine_status
triggers: l-usdt, liquid usdt, usdt on liquid, l-btc, liquid bitcoin, submarine, submarine swap, pay invoice with liquid, swap status
metadata:
  author: kaleidoswap
  version: "0.1.0"
---

# Submarine swaps — pay Lightning from Liquid

A submarine swap pays a Lightning (BOLT11) invoice with funds the user locks on
Liquid. The KaleidoSwap maker pays the invoice, then claims the lockup. It is
atomic: if the maker can't pay, the lockup is refunded to the user.

## Critical rules

- Every amount, fee and status in your reply MUST come from a tool result in the
  CURRENT turn. Never guess the amount to lock — `kaleidoswap_submarine_create`
  returns it.
- `kaleidoswap_submarine_fund` moves money. Call it ONLY after the user has
  confirmed the exact `expected_amount` returned by `kaleidoswap_submarine_create`.
- `kaleidoswap_submarine_fund` takes only `swap_id`. Never try to pass an amount
  or an address.
- A bare "USDT" means RGB USDT on the Lightning node, which uses the atomic swap
  tools, not this skill. Use this skill only for Liquid assets (L-USDT, L-BTC).

## Flow

1. `kaleidoswap_submarine_create { invoice, from_asset }` — from_asset is
   `L-USDT` (default) or `L-BTC`. Returns `swap_id`, `expected_amount` (smallest
   unit: L-USDT has 8 decimals, L-BTC is sats) and the fees.
2. Tell the user the amount and ask to confirm.
3. `kaleidoswap_submarine_fund { swap_id }`.
4. `kaleidoswap_submarine_status { swap_id }` — `transaction.claimed` means the
   invoice was paid. `failed: true` on a funded swap means the funds need a refund;
   say so and quote the `refund` field.

Use `kaleidoswap_submarine_pairs` when the user asks what can pay a Lightning
invoice, or for the limits and fees.

## Examples

- "pay lntbs10u1p… with L-USDT" →
  `kaleidoswap_submarine_create { invoice: "lntbs10u1p…", from_asset: "L-USDT" }`
- "did my Liquid payment go through? swap sub1" →
  `kaleidoswap_submarine_status { swap_id: "sub1" }`
