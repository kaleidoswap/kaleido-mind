---
name: bitrefill
description: "Buy gift cards, mobile top-ups and eSIMs on Bitrefill (1,500+ brands, 180+ countries), paid from the Bitrefill balance or over Lightning: search, pick a package, create the invoice, read the redemption code."
tools: bitrefill_search, bitrefill_get_product, bitrefill_get_balance, bitrefill_create_invoice, bitrefill_get_invoice, bitrefill_get_order, spark_pay_invoice, rln_pay_invoice
requires-tools: bitrefill_search
triggers: bitrefill, gift card, gift cards, giftcard, voucher, top-up, topup, top up, esim, e-sim, mobile plan, prepaid, amazon, steam, google play, app store, itunes, playstation, xbox, netflix, spotify, uber
compatibility: "Needs BITREFILL_API_KEY (Personal) or BITREFILL_API_ID + BITREFILL_API_SECRET (Business); without them the tools are not registered."
metadata:
  author: bitrefill
  version: "3.1.0"
  homepage: "https://www.bitrefill.com"
  docs: "https://docs.bitrefill.com"
  repository: "https://github.com/bitrefill/agents"
---
# Bitrefill

Product and package ids come from `bitrefill_search` and
`bitrefill_get_product` in this turn; never invent them.

## Do
1. `bitrefill_search` (`query`, optional `country`); if several products match, ask once.
2. `bitrefill_get_product` (`product_id`); pick the package whose `value` matches
   and use its `id` as `package_id`.
3. Show product, value, total price and payment method, then
   `bitrefill_create_invoice` (confirm-gated):
   - default `payment_method: "balance"` with `auto_pay: true` (check
     `bitrefill_get_balance` first);
   - `"lightning"` needs `refund_address`; pay the returned BOLT11 with
     `spark_pay_invoice` or `rln_pay_invoice`.
4. Poll `bitrefill_get_invoice` until `complete`, then `bitrefill_get_order`.
   Show `redemption_info.code` once and never repeat it.
- 401 means the API key is missing or wrong: say so and stop.

## Examples
- "A $25 Amazon US gift card" → `bitrefill_search {"query":"amazon","country":"US"}`
- "Show the packages" → `bitrefill_get_product {"product_id":"amazon-us"}`
- "Buy it with my balance" → `bitrefill_create_invoice {"products":[{"product_id":"amazon-us","package_id":"<package id>","quantity":1}],"payment_method":"balance","auto_pay":true}`

Hosts without these tools (remote MCP, CLI, browser): see `references/`.
