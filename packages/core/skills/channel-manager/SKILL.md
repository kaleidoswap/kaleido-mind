---
name: channel-manager
description: "Lightning channels and liquidity for the RGB Lightning Node: node health, channel audit, inbound/outbound balance, buying a channel or asset channel from the KaleidoSwap LSP, opening and closing channels. Runs the scheduled heartbeat."
tools: rln_get_node_info, rln_list_channels, rln_get_balances, rln_refresh_transfers, rln_connect_peer, rln_open_channel, rln_close_channel, rln_get_channel_id, rln_pay_invoice, kaleidoswap_lsp_get_info, kaleidoswap_lsp_estimate_fees, kaleidoswap_lsp_create_order, kaleidoswap_lsp_get_order, kaleidoswap_lsp_quote_asset_channel, kaleidoswap_lsp_create_asset_channel
requires-tools: rln_list_channels
triggers: channel, channels, liquidity, inbound, outbound, lsp, lsps1, capacity, rebalance channel, can't receive, open channel, close channel, channel order, heartbeat, health, stuck
metadata:
  author: kaleidoswap
  version: "0.2.0"
---
# Channel manager

Read state first: `rln_get_node_info`, `rln_list_channels`, `rln_get_balances`.
Outbound = what the node can send; inbound = what it can receive. Report
numbers from this turn's results only.

## Do
- Health: count usable channels, total outbound vs inbound, channels with
  `is_usable: false`; `rln_refresh_transfers {}` flushes pending RGB transfers.
- Can't receive → buy inbound: `kaleidoswap_lsp_get_info` (limits and
  `lsp_connection_url`), `rln_connect_peer`, `kaleidoswap_lsp_estimate_fees`
  (show `total_fee`), then `kaleidoswap_lsp_create_order` with `client_pubkey`
  from `rln_get_node_info`, pay its invoice with `rln_pay_invoice`, poll
  `kaleidoswap_lsp_get_order` until `COMPLETED`.
- Wants an asset (USDT/XAUT) but has no channel →
  `kaleidoswap_lsp_quote_asset_channel` then
  `kaleidoswap_lsp_create_asset_channel` with the fresh `rfq_id`.
- Can't send → open a channel with spare on-chain BTC (`rln_open_channel`).
- Every order, open, close and payment is confirm-gated; recommend first,
  execute only on an explicit request. With `dry_run` true, describe only.
- Heartbeat runs: `action` is `ok`, `flush`, `buy_capacity` or `alert`.

## Examples
- "How healthy is my node?" → `rln_list_channels {}`
- "Fee for 500k sats inbound?" → `kaleidoswap_lsp_estimate_fees {"lsp_balance_sat":500000,"client_balance_sat":0,"channel_expiry_blocks":4320}`
- "Buy 500k inbound" → `rln_get_node_info {}` then `kaleidoswap_lsp_create_order {"client_pubkey":"<pubkey>","lsp_balance_sat":500000,"client_balance_sat":0,"channel_expiry_blocks":4320}`
- "A channel holding 100 USDT" → `kaleidoswap_lsp_quote_asset_channel {"asset":"USDT","asset_amount":100}`
- "Did order 7a1b open?" → `kaleidoswap_lsp_get_order {"order_id":"7a1b"}`
