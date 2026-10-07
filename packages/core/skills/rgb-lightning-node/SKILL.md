---
name: rgb-lightning-node
description: "Operate the user's RGB Lightning Node: RGB asset balances, issue a new RGB token or NFT, RGB and Lightning invoices, send assets or BTC, pay invoices, channels and node status."
tools: rln_get_node_info, rln_get_balances, rln_list_assets, rln_get_asset_balance, rln_refresh_transfers, rln_list_transfers, rln_create_utxos, rln_issue_asset, rln_create_rgb_invoice, rln_send_asset, rln_create_ln_invoice, rln_pay_invoice, rln_get_address, rln_send_btc, rln_list_channels, rln_list_payments
requires-tools: rln_get_node_info
triggers: node, pubkey, balance, balances, rgb, asset, assets, token, nft, issue, mint, utxos, transfers, invoice, receive, send asset, pay invoice, on-chain address, channels, payments
metadata:
  author: kaleidoswap
  version: "0.4.0"
---
# RGB Lightning Node

Every value in a reply comes from a tool result in this turn. RGB `asset_id`s
look like `rgb:…`; a ticker is not an id — find the id with `rln_list_assets`.
Amounts are display units (10 = 10 USDT) except fields named `*_sat`/`*_sats`.

## Do
- Holdings: one `rln_list_assets {}` call. Each asset already carries
  `balance` (`spendable`, `settled`, `future`, `offchain_outbound`,
  `offchain_inbound`) in raw units: divide by 10^`precision`. Assets held in a
  Lightning channel show in `offchain_outbound`. Use `rln_get_asset_balance`
  only for a single asset the user names.
- Issue: `rln_issue_asset` (confirm-gated). `ticker` 1–8 uppercase letters or
  digits; `amount` is the total supply; `precision` defaults to 0;
  `schema` is `NIA` (token, default), `CFA` (collectible, no ticker) or `UDA`
  (NFT, supply 1). If it fails with "no available UTXOs", call
  `rln_create_utxos {}` and retry. Reply with the new `asset_id`.
- Send an asset: `recipient_id` is the `utxob:…`/`wvout:…` part of the RGB
  invoice. Never invent a recipient or an invoice.
- Receive: `rln_create_rgb_invoice` (RGB) or `rln_create_ln_invoice` (BTC over
  Lightning); reply with the full `invoice` string.
- Stale balance or transfer: `rln_refresh_transfers {}` once, then re-read.
- Node unreachable or locked: switch to the `kaleido-node` skill.

## Examples
- "Which RGB assets do I hold?" → `rln_list_assets {}`
- "Issue a token named Skill Test, ticker SKT, supply 1000" → `rln_issue_asset {"name":"Skill Test","ticker":"SKT","amount":1000,"precision":0}`
- "Send 5 SKT to rgb:~/~/~/sig/any/1/utxob:abc" → `rln_list_assets {}` then `rln_send_asset {"asset_id":"<SKT asset_id>","recipient_id":"utxob:abc","amount":5}`
- "Invoice me 10 USDT" → `rln_create_rgb_invoice {"asset_id":"<USDT asset_id>","amount":10}`
- "Lightning invoice for 5000 sats" → `rln_create_ln_invoice {"amount_sats":5000}`

Channels, peers and swap internals: read `references/channels.md`.
