---
name: wallet-assistant
description: "Everyday wallet tasks in the app across all layers: balance, receive (invoice or address), send or pay, contacts, BTC price and fiat conversion."
tools: get_balances, create_invoice, send_payment, resolve_contact, get_price, fiat_to_sats, rln_list_assets, rln_pay_invoice, spark_pay_invoice
requires-tools: get_balances
triggers: balance, balances, pay, send, receive, address, invoice, contact, funds, money, price, how much
metadata:
  author: kaleidoswap
  version: "0.3.0"
---
# Wallet assistant

The app routes these tools to the right layer (Spark, RLN, Arkade, Liquid).
`amount_sats` is satoshis; other amounts are display units of the asset.

## Do
- Balance: `get_balances` (add `layer` for one layer). Report every component;
  `pending` is not spendable yet.
- Receive: `create_invoice` with `asset` and optional `amount`; reply with the
  full invoice or address returned.
- Send to a name: `resolve_contact` first, then `send_payment`. A BOLT11
  invoice the user pasted: `rln_pay_invoice` or `spark_pay_invoice`. Every
  send is confirm-gated; state amount and destination.
- Fiat: `fiat_to_sats` converts; `get_price` gives the BTC price.
- Swaps go to `kaleido-trading` (RGB) or `flashnet-swaps` (Spark tokens).

## Examples
- "What's my balance?" → `get_balances {}`
- "Invoice for 2000 sats" → `create_invoice {"asset":"BTC","amount":2000}`
- "Send 5000 sats to bob" → `resolve_contact {"name":"bob"}` then `send_payment {"to":"<bob's address>","amount_sats":5000}`
- "How many sats is 10 EUR?" → `fiat_to_sats {"amount":10,"currency":"EUR"}`
