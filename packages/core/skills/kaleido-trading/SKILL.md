---
name: kaleido-trading
description: "Quote and run KaleidoSwap atomic swaps between BTC and RGB assets (USDT, XAUT): pairs, assets, quotes, swap execution and swap status."
tools: kaleidoswap_get_pairs, kaleidoswap_get_assets, kaleidoswap_get_quote, kaleidoswap_atomic_init, rln_atomic_taker, rln_get_node_info, kaleidoswap_atomic_execute, kaleidoswap_atomic_status, rln_refresh_transfers, rln_list_channels
requires-tools: kaleidoswap_get_quote
triggers: quote, swap, trade, pair, pairs, usdt, xaut, kaleidoswap, rfq, atomic, swap status
metadata:
  author: kaleidoswap
  version: "0.7.0"
---
# KaleidoSwap trading

Amounts in `kaleidoswap_get_quote` are **display units**: `from_amount: 0.0005`
means 0.0005 BTC (50,000 sats; 1 BTC = 100,000,000 sats). Asset ids accept a
ticker (`BTC`, `USDT`, `XAUT`) or an `rgb:…` id.

A swap runs over Lightning: it needs a channel with enough outbound in the
asset you send and enough inbound in the asset you receive. If
`rln_list_channels` shows none, buy one first (see `channel-manager`).
Each leg is one payment plus the node's 3,000-sat HTLC minimum: sending BTC
needs one channel whose `next_outbound_htlc_limit_msat` (about 10% of its
capacity) ≥ amount + 3,000 sats, receiving BTC inbound ≥
amount + 3,000; the asset side needs an asset channel holding the asset (or
inbound for it). Short: offer a smaller swap or a bigger channel.

## Do
- Quote with exactly one amount: `from_amount` to sell a fixed input,
  `to_amount` to buy a fixed output. No amount given → ask for one.
- Report `from_asset.amount_display`, `to_asset.amount_display` and
  `expires_at` as given; `price` is in the maker's raw units, don't quote it.
  The quote expires in about 60 s.
- Executing a swap moves funds: only after the user says yes to that quote.
  Chain: `kaleidoswap_atomic_init` (rfq_id, both asset ids, both `amount_raw`
  values unchanged) → `rln_atomic_taker` (swapstring) → `rln_get_node_info`
  (pubkey) → `kaleidoswap_atomic_execute` → poll `kaleidoswap_atomic_status`.
  Details and errors: `references/atomic.md`.
- `USD` is not `USDT` and `gold` is not `XAUT`: confirm before quoting.
  Spark tokens such as USDB trade on Flashnet (`flashnet-swaps`), not here.

## Examples
- "Quote 0.0005 BTC to USDT" → `kaleidoswap_get_quote {"from_asset_id":"BTC","to_asset_id":"USDT","from_amount":0.0005}`
- "Swap 100k sats into XAUT" → `kaleidoswap_get_quote {"from_asset_id":"BTC","to_asset_id":"XAUT","from_amount":0.001}`
- "I want to receive 10 USDT, how much BTC?" → `kaleidoswap_get_quote {"from_asset_id":"BTC","to_asset_id":"USDT","to_amount":10}`
- "Status of swap 9f2c…" → `kaleidoswap_atomic_status {"payment_hash":"9f2c…"}`
