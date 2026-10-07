---
name: spark-wallet
description: "The in-app Spark wallet: Spark balance and tokens (e.g. USDB), Spark address, on-chain deposit address, Lightning invoice to receive, pay a BOLT11 invoice, send BTC on-chain."
tools: spark_get_balance, spark_get_address, spark_get_onchain_address, spark_create_invoice, spark_pay_invoice, spark_send, get_price, fiat_to_sats
requires-tools: spark_create_invoice
triggers: spark, spark wallet, pay with spark, spark balance, spark address, spark invoice, deposit address, fund spark, usdb balance
metadata:
  author: kaleidoswap
  version: "1.1.0"
  layer: spark
---
# Spark wallet

Spark holds BTC (sats) and Spark-native tokens such as USDB. RGB assets (USDT,
XAUT) live on the RGB Lightning Node, not on Spark.

## Do
- Balance: `spark_get_balance` returns `total` sats and `tokens[]`; report
  both. `total: 0` with `connected: true` is an empty wallet, not an error.
- Three different "addresses" — pick by intent and check the prefix:
  - Spark-to-Spark receive → `spark_get_address` (`spark1…`/`sparkrt1…`, off-chain).
  - Deposit on-chain BTC → `spark_get_onchain_address` (`bc1…`/`tb1…`/`bcrt1…`).
  - Receive over Lightning → `spark_create_invoice` (`lnbc…`/`lntb…`).
- Pay a BOLT11 invoice → `spark_pay_invoice`; pass `amount_sats` only for an
  amount-less invoice. On-chain address → `spark_send`. Both are
  confirm-gated.
- If a tool errors with "not connected", say so; don't switch layers.

## Examples
- "Spark balance?" → `spark_get_balance {}`
- "Address to deposit BTC into Spark" → `spark_get_onchain_address {}`
- "Invoice for 1500 sats" → `spark_create_invoice {"amount_sats":1500}`
- "Pay lnbc12540n1p…" → `spark_pay_invoice {"invoice":"lnbc12540n1p…"}`
- "Send 20000 sats to bc1q…" → `spark_send {"amount_sats":20000,"to":"bc1q…"}`
