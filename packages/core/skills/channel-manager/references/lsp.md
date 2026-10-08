# Buying a channel from the KaleidoSwap LSP (LSPS1)

Verified on signet against a node with 10,000 sats on-chain and no channels.
Field names are kaleido-mcp 0.4.2.

## Which channel to buy

- Receive only: `lsp_balance_sat` = inbound you want, `client_balance_sat` 0.
- Swap BTC → USDT/XAUT over Lightning: you send BTC and receive the asset, so
  the channel needs BTC outbound (`client_balance_sat`) and asset inbound
  (`asset_id` + `lsp_asset_amount`, raw units = display × 10^precision).
  The BTC leg goes out as one payment of the swap amount plus 3,000 sats
  (the RGB node's HTLC minimum), and outbound is about 1,000 sats less than
  `client_balance_sat`. So set `client_balance_sat` to at least the largest
  swap you plan + 6,000. One payment is also capped at about 10% of the
  channel's capacity (`next_outbound_htlc_limit_msat`: 5,400 sats on a 54,000
  channel), so the capacity (`lsp_balance_sat` + `client_balance_sat`) must be
  at least 10 × (swap + 3,000). With 4,000 (the example below) the channel works but
  no BTC → asset swap fits.
- Swap USDT/XAUT → BTC: you need the asset on your side; buy it with
  `kaleidoswap_lsp_quote_asset_channel` → `kaleidoswap_lsp_create_asset_channel`.

## Steps

1. `kaleidoswap_lsp_get_info {}`: `lsp_connection_url`, `min_channel_balance_sat`
   (50,000 on signet), `max_channel_expiry_blocks`, and the asset ids.
2. `rln_connect_peer {"peer_pubkey_and_addr":"<lsp_connection_url>"}`
3. `kaleidoswap_lsp_estimate_fees {"lsp_balance_sat":50000,"client_balance_sat":4000,"channel_expiry_blocks":4320,"asset_id":"<rgb:… USDT id>","lsp_asset_amount":10000000}`
   → `total_fee` 2,972. (A 4,000-sat `client_balance_sat` buys inbound only;
   for a 20,000-sat swap use 26,000.)
4. Confirm the ORDER with the user, showing the order total (the estimate's
   `total_fee` + `client_balance_sat`). `kaleidoswap_lsp_create_order` is
   confirmation-gated on MCP hosts.
   `kaleidoswap_lsp_create_order {"client_pubkey":"<pubkey>","lsp_balance_sat":50000,"client_balance_sat":4000,"channel_expiry_blocks":4320,"asset_id":"<rgb:… USDT id>","lsp_asset_amount":10000000}`
   → `order_id`, `access_token`, `amount_due_sat` 6,972 (fee + `client_balance_sat`),
   `fee_sat` 2,972, and `payment.bolt11` / `payment.onchain`, each with
   `amount_sat` = `amount_due_sat`. Keep `order_id` and `access_token`. The
   order expires after 10 minutes.
5. Confirm the PAYMENT with the user, then pay `amount_due_sat`, never `fee_sat`.
   Without a channel only on-chain works:
   `rln_send_btc {"address":"<payment.onchain.address>","amount_sat":6972,"fee_rate":2}`.
6. Poll `kaleidoswap_lsp_get_order {"order_id":"<order_id>","access_token":"<access_token>"}`
   until `COMPLETED`. The LSP opens the channel about 30 s after it sees the
   payment (0-conf); `rln_list_channels {}` shows it as `Opening`, then
   `is_usable: true` after the funding transaction confirms (about 4 minutes
   on signet).

For an asset channel, `kaleidoswap_lsp_quote_asset_channel` returns
`btc_amount_sat` (asset price) + `channel_fee_sat` = `total_sat`, all in sats;
`kaleidoswap_lsp_create_asset_channel` returns the same order shape, so pay its
`amount_due_sat`.

## Fees (signet, 2026-10)

setup 1,000 + capacity about 1% of the channel + duration about 0.1 sat per
block, plus 1,000 for asset inbound (`lsp_asset_amount`) or 5,000 + 1% of the
price for an asset you buy (`client_asset_amount`); an order costs at least 2,000.
Examples: 50,000 inbound for 4,320 blocks = 2,000; the USDT channel above =
2,972. Add the on-chain fee of the payment (about 300 sats at 2 sat/vB).
