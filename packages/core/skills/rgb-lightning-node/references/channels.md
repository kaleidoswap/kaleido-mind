# Channels, peers, payments and swaps

| Tool | Arguments | Notes |
|---|---|---|
| `rln_get_node_info` | — | `pubkey`, `num_channels`, `num_usable_channels`, `local_balance_sat` (what you can **send**, not receive) |
| `rln_list_channels` | `usable_only?` | Per channel: `capacity_sat`, outbound (send) and inbound (receive) balance, `is_usable`, RGB `asset_id` + local/remote asset amounts |
| `rln_get_balances` | `skip_sync?` | On-chain BTC (vanilla + colored) and Lightning BTC. RGB assets are in `rln_list_assets` |
| `rln_connect_peer` | `peer_pubkey_and_addr` | `pubkey@host:port` |
| `rln_open_channel` | `peer_pubkey_and_addr`, `capacity_sat`, `push_msat?`, `asset_id?`, `asset_amount?`, `is_public?` | Confirm-gated. Opens asynchronously: report `temporary_channel_id` |
| `rln_get_channel_id` | `temporary_channel_id` | Final `channel_id` once open |
| `rln_close_channel` | `channel_id`, `peer_pubkey`, `force?` | Confirm-gated. `force` only for an unresponsive peer |
| `rln_list_payments` | `limit?` | Lightning payments sent and received |
| `rln_pay_invoice` | `invoice` | Confirm-gated. The BOLT11 string, unchanged |
| `rln_get_address` | — | On-chain BTC deposit address (not an invoice) |
| `rln_send_btc` | `address`, `amount_sat`, `fee_rate?` | Confirm-gated |
| `rln_list_transfers` | `asset_id` | RGB transfers with status `WaitingCounterparty` → `WaitingConfirmations` → `Settled` / `Failed` |
| `rln_list_swaps` / `rln_get_swap` | — / `payment_hash`, `taker?` | The node's view of atomic swaps |
| `rln_atomic_taker` | `swapstring` | Confirm-gated. Whitelists a maker swap; see the `kaleido-trading` skill |

A channel bought from an LSP appears in `rln_list_channels` only after its
funding transaction confirms; if it is missing, say it is still opening.

## Issuing and distributing an asset

1. `rln_get_node_info {}` — node reachable and unlocked.
2. `rln_create_utxos {}` — only on a fresh node or after "no available UTXOs";
   wait for the funding transaction to confirm.
3. `rln_issue_asset {"name":"Hackathon Ticket","ticker":"TICKET","amount":1000}`.
4. The receiver runs `rln_create_rgb_invoice`; you run `rln_send_asset` with
   the new `asset_id` and the invoice's `recipient_id`.
5. `rln_refresh_transfers {}` then `rln_list_transfers {"asset_id":"<asset_id>"}`
   until the transfer is `Settled`.

kaleido-mcp also exposes every `rln_*` tool as `wdk_*` with the same arguments.
