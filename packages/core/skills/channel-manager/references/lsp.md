# Buying a channel from the KaleidoSwap LSP (LSPS1)

Verified on signet with kaleido-mcp 0.4.1 against a node with 10,000 sats
on-chain and no channels.

## Which channel to buy

- Receive only: `lsp_balance_sat` = inbound you want, `client_balance_sat` 0.
- Swap BTC → USDT/XAUT over Lightning: you send BTC and receive the asset, so
  the channel needs BTC outbound (`client_balance_sat`) and asset inbound
  (`asset_id` + `lsp_asset_amount`, raw units = display × 10^precision).
  An RGB Lightning payment carries at least 3,000 sats, and outbound is about
  1,000 sats less than `client_balance_sat`, so use at least 4,000.
- Swap USDT/XAUT → BTC: you need the asset on your side; buy it with
  `kaleidoswap_lsp_quote_asset_channel` → `kaleidoswap_lsp_create_asset_channel`.

## Steps

1. `kaleidoswap_lsp_get_info {}`: `lsp_connection_url`, `min_channel_balance_sat`
   (50,000 on signet), `max_channel_expiry_blocks`, and the asset ids.
2. `rln_connect_peer {"peer_pubkey_and_addr":"<lsp_connection_url>"}`
3. `kaleidoswap_lsp_estimate_fees {"lsp_balance_sat":50000,"client_balance_sat":4000,"channel_expiry_blocks":4320,"asset_id":"<rgb:… USDT id>","lsp_asset_amount":10000000}`
   → `total_fee` 2,972.
4. `kaleidoswap_lsp_create_order {"client_pubkey":"<pubkey>","lsp_balance_sat":50000,"client_balance_sat":4000,"channel_expiry_blocks":4320,"asset_id":"<rgb:… USDT id>","lsp_asset_amount":10000000}`
   → `order_id`, `access_token`, and `payment.bolt11` / `payment.onchain`, both
   with `order_total_sat` 6,972 (fee + `client_balance_sat`). The order
   expires after 10 minutes.
5. Pay `order_total_sat`. Without a channel only on-chain works:
   `rln_send_btc {"address":"<payment.onchain.address>","amount_sat":6972,"fee_rate":2}`.
   The flat `onchain_amount_sat` field holds the fee only; do not pay that.
6. The LSP opens the channel about 30 s after it sees the payment (0-conf);
   `rln_list_channels {}` shows it as `Opening`, then `is_usable: true` after
   the funding transaction confirms (about 4 minutes on signet).

`kaleidoswap_lsp_get_order` needs the order's `access_token`; kaleido-mcp 0.4.1
does not pass it and returns "Invalid order access token", so track the order
with `rln_list_channels`.

## Fees (signet, 2026-10)

setup 1,000 + capacity about 1% of the channel + duration about 0.1 sat per
block, plus 1,000 for an asset channel; a BTC-only order costs at least 2,000.
Examples: 50,000 inbound for 4,320 blocks = 2,000; the USDT channel above =
2,972. Add the on-chain fee of the payment (about 300 sats at 2 sat/vB).
