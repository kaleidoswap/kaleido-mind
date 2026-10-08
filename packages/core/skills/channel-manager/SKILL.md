---
name: channel-manager
description: "Lightning channels and liquidity for the RGB Lightning Node: node health, channel audit, inbound/outbound balance, buying a channel or asset channel from the KaleidoSwap LSP, opening and closing channels. Runs the scheduled heartbeat."
tools: rln_get_node_info, rln_list_channels, rln_get_balances, rln_refresh_transfers, rln_connect_peer, rln_open_channel, rln_close_channel, rln_get_channel_id, rln_pay_invoice, rln_send_btc, kaleidoswap_lsp_get_info, kaleidoswap_lsp_estimate_fees, kaleidoswap_lsp_create_order, kaleidoswap_lsp_get_order, kaleidoswap_lsp_quote_asset_channel, kaleidoswap_lsp_create_asset_channel
requires-tools: rln_list_channels
triggers: channel, channels, liquidity, inbound, outbound, lsp, lsps1, capacity, rebalance channel, can't receive, open channel, close channel, channel order, buy a channel, no channel, heartbeat, health, stuck
metadata:
  author: kaleidoswap
  version: "0.3.0"
---
# Channel manager

Read state first: `rln_get_node_info`, `rln_list_channels`, `rln_get_balances`.
Outbound = what the node can send; inbound = what it can receive. Report
numbers from this turn's results only. All `*_sat` fields are sats.

## Do
- Health: count usable channels, total outbound vs inbound, channels with
  `is_usable: false`; `rln_refresh_transfers {}` flushes pending RGB transfers.
- Buy a channel from the LSP (also the step before a first swap):
  1. `kaleidoswap_lsp_get_info` → `lsp_connection_url`, limits, asset ids.
  2. `rln_connect_peer` with `lsp_connection_url`.
  3. `kaleidoswap_lsp_estimate_fees`, show `total_fee`.
  4. `kaleidoswap_lsp_create_order` with `client_pubkey` from `rln_get_node_info`.
     `lsp_balance_sat` (min 50,000) is inbound; `client_balance_sat` is your
     outbound, paid by you. BTC→asset swap: add `asset_id` (`rgb:` id),
     `lsp_asset_amount` raw (10 USDT = 10000000), `client_balance_sat` ≥ swap + 6,000.
  5. Pay `amount_due_sat` (fee + `client_balance_sat`), never `fee_sat`.
     With no channel, pay on-chain: `rln_send_btc` to `payment.onchain.address`.
  6. Poll `kaleidoswap_lsp_get_order` with `order_id` + `access_token`, then
     `rln_list_channels` until `is_usable`. Fees: `references/lsp.md`.
- Wants to hold an asset (USDT/XAUT) bought with the channel →
  `kaleidoswap_lsp_quote_asset_channel` then
  `kaleidoswap_lsp_create_asset_channel` with the fresh `rfq_id`.
- Can't send → `rln_open_channel` with spare on-chain BTC.
- Every order, open, close and payment is confirm-gated; recommend first,
  execute only on an explicit request. With `dry_run` true, describe only.
- Heartbeat runs: `action` is `ok`, `flush`, `buy_capacity` or `alert`.

## Examples
- "How healthy is my node?" → `rln_list_channels {}`
- "Buy 500k inbound" → `rln_get_node_info {}` then `kaleidoswap_lsp_create_order {"client_pubkey":"<pubkey>","lsp_balance_sat":500000,"client_balance_sat":0,"channel_expiry_blocks":4320}`
- "A channel to swap BTC for USDT" → `kaleidoswap_lsp_estimate_fees {"lsp_balance_sat":50000,"client_balance_sat":4000,"channel_expiry_blocks":4320,"asset_id":"<USDT rgb id>","lsp_asset_amount":10000000}`
- "Pay the order on-chain" → `rln_send_btc {"address":"<payment.onchain.address>","amount_sat":6972}`
- "A channel holding 100 USDT" → `kaleidoswap_lsp_quote_asset_channel {"asset":"USDT","asset_amount":100}`
