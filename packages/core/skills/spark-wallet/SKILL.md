---
name: spark-wallet
description: "Operate the user's Spark BTC wallet on this device — check Spark balance, get a Spark deposit address, create a Spark Lightning invoice to receive, pay any BOLT11 Lightning invoice with Spark, or send BTC on-chain from Spark. Use this when the user names Spark explicitly OR when paying a Lightning invoice on a phone where Spark is the connected layer. Pairs with the bitrefill skill: a Bitrefill purchase that returns a Lightning invoice is paid with `spark_pay_invoice`."
tools: spark_get_balance, spark_get_address, spark_create_invoice, spark_pay_invoice, spark_send, get_price, fiat_to_sats, bitrefill_search, bitrefill_get_product, bitrefill_get_balance, bitrefill_create_invoice, bitrefill_get_invoice, bitrefill_get_order
triggers: spark, spark wallet, pay with spark, send with spark, spark balance, spark address, spark invoice, lightning invoice, pay invoice, bolt11, ln invoice, pay this invoice
metadata:
  author: kaleidoswap
  version: "1.0.0"
  layer: spark
---

# Spark wallet

Spark is one of the user's connected BTC layers (alongside RLN/RGB and Arkade
on some hosts). It speaks Lightning natively — receive via `spark_create_invoice`,
send via `spark_pay_invoice` (BOLT11) or `spark_send` (on-chain). All numbers
are in **satoshis** unless stated otherwise.

## Critical rules (read first)

1. **Never invent a balance, invoice or address.** Every BTC number, BOLT11
   string, and address in your reply MUST come from a Spark tool result
   returned in the CURRENT turn.
2. **Choose the right send tool by destination shape.**
   - Starts with `lnbc…` / `lntb…` / `lnbcrt…` → BOLT11 Lightning invoice → use
     **`spark_pay_invoice`**.
   - Starts with `bc1…` / `tb1…` / `bcrt1…` → on-chain Bitcoin address → use
     **`spark_send`**.
   - Looks like `name@domain` (a Lightning address) → not a Spark target;
     either ask the host to resolve it first or use the cross-cutting
     `send_payment` router. Spark itself doesn't dereference LNURL.
3. **BOLT11 invoices encode their amount.** Don't pass `amount_sats` to
   `spark_pay_invoice` unless the invoice is amount-less. Re-stating the
   amount can produce silently-wrong sends on amount-less invoices.
4. **Confirm before spending.** `spark_pay_invoice` and `spark_send` are
   confirmation-gated by the contract — the host fires the gate
   automatically. Before the call, summarize in one line:
   `Paying 12,540 sats to lnbc12540n… from Spark. Confirm?`
5. **No Spark connected = stop, don't guess.** If `spark_get_balance` /
   `spark_get_address` throws "Your SPARK wallet isn't connected yet", say so
   plainly and stop — don't substitute RLN or Arkade silently. The user may
   genuinely want Spark.

## How to call the tools

### Reads

- **`spark_get_balance({})`** — current spendable BTC in Spark (sats).
- **`spark_get_address({})`** — a Spark deposit address. Surface as-is.

### Receive

- **`spark_create_invoice({ amount_sats? })`** — Spark Lightning invoice.
  - Omit `amount_sats` for an "any amount" invoice.
  - Returns `{ invoice: "lnbc…", … }`.

### Send — pick by destination

- **`spark_pay_invoice({ invoice, amount_sats? })`** — pay a BOLT11 invoice.
  - The model's default Lightning spend tool. Use this for invoices from
    Bitrefill, a contact's invoice paste, or any `ln…` string.
  - Pass `amount_sats` ONLY when the invoice is amount-less (a 0-amount
    invoice). For ordinary amount-bound invoices, OMIT it.
- **`spark_send({ amount_sats, to })`** — on-chain Bitcoin send.
  - Use only when `to` is an on-chain address (`bc1…`). Never pass a BOLT11
    invoice here.

### Helpers

- **`get_price({ fiat? })`** / **`fiat_to_sats({ amount, currency })`** —
  for "how many sats is €10" style sub-questions before a Spark spend.

## Cross-skill flow with Bitrefill

When the user wants to buy something from Bitrefill and pay with Spark, the
typical chain is:

1. Call `bitrefill_search` / `bitrefill_get_product` to confirm the product +
   the right `package_id` (see the `bitrefill` skill).
2. Call `bitrefill_create_invoice({ products, payment_method: "lightning",
   refund_address: <a Spark or on-chain address> })` — Bitrefill returns a
   BOLT11 invoice on the response under `payment.lightning_invoice` (or
   similar — relay whatever the host surfaces).
3. **Pay with Spark**: `spark_pay_invoice({ invoice: <that BOLT11> })`. One
   confirmation gate; Spark settles the invoice in seconds.
4. Poll `bitrefill_get_invoice` until `status:"complete"`, then
   `bitrefill_get_order` for the redemption code.

If the user pre-funded a Bitrefill account, prefer
`payment_method:"balance"` instead — no Spark spend, instant settlement. Use
the Lightning path when the user explicitly says "pay with Spark/Lightning"
or has no Bitrefill balance.

## Reply style

- One short sentence per fact ("Spark holds 124,500 sats.").
- For invoices: show the invoice on its own line so the user can copy it.
- For sends: one-line pre-spend summary (amount + destination + "from
  Spark"), then the result.
- When `spark_get_balance` says zero and the user asked to spend, stop and
  say so — don't try to source funds from another layer silently.
