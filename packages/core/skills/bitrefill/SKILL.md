---
name: bitrefill
description: "Buy or browse Bitrefill — 1,500+ gift cards, mobile top-ups, and eSIMs across 180+ countries, payable in crypto, Lightning, USDC via x402, or pre-funded account balance. Use these tools to actually transact: bitrefill_search → bitrefill_get_product → bitrefill_create_invoice (spend, confirmed) → bitrefill_get_invoice/bitrefill_get_order for the redemption code."
tools: bitrefill_search, bitrefill_get_product, bitrefill_get_balance, bitrefill_create_invoice, bitrefill_get_invoice, bitrefill_get_order
triggers: bitrefill, gift card, gift cards, giftcard, voucher, vouchers, top-up, topup, top up, refill, esim, e-sim, mobile plan, mobile top-up, prepaid, amazon, steam, google play, app store, itunes, playstation, xbox, netflix, spotify, uber
compatibility: "Live REST adapter on the CLI/desktop when BITREFILL_API_KEY (Personal) or BITREFILL_API_ID + BITREFILL_API_SECRET (Business) are set. Without those env vars the tools aren't registered — tell the user and stop."
metadata:
  author: bitrefill
  version: "3.0.0"
  homepage: "https://www.bitrefill.com"
  docs: "https://docs.bitrefill.com"
  repository: "https://github.com/bitrefill/cli"
---

# Bitrefill

Bitrefill sells digital goods (gift cards, mobile top-ups, eSIMs) across 180+
countries. Codes deliver instantly after the invoice settles.

This skill is **action-shaped**: when the host has the `bitrefill_*` tools
wired, you transact through them directly. Don't navigate browser / MCP / CLI
fallbacks unless the tools are absent.

## Critical rules (read first)

1. **Never invent product or package ids.** Every `product_id` and
   `package_id` MUST come from a `bitrefill_search` + `bitrefill_get_product`
   result in the current turn.
2. **Confirm before spending.** `bitrefill_create_invoice` is the spend — it
   is automatically confirmation-gated by the host. Before calling it, show
   the user product, denomination, total price, and payment method in plain
   English, then call the tool. The host will fire one confirmation; on
   approve, the invoice is created.
3. **Codes are cash.** When you read `redemption_info.code` from
   `bitrefill_get_order`, return it once, advise the user to store it
   securely, and **never** repeat it in summaries or future turns.
4. **No tools wired = no purchase.** If `bitrefill_search` isn't available
   in this session (no API key configured), say so directly: *"Bitrefill
   purchases need a `BITREFILL_API_KEY` env var. Set one and restart, or
   browse <https://www.bitrefill.com> directly."* Don't fall back to
   inventing products.

## Happy-path playbook

For a typical buy ("a $25 Amazon US gift card with my balance"):

1. **`bitrefill_search({ query, country? })`** — find candidate products.
   - "amazon" → `{ query: "amazon", country: "US" }` if the user named a
     country, else just `{ query: "amazon" }`.
   - Returns a list of `{ id, name, country, category }` rows. Pick the one
     that matches the user's intent. If multiple plausible matches, ask the
     user once instead of guessing.

2. **`bitrefill_get_product({ product_id })`** — read the `packages` array
   for the right denomination. Each package has `{ id, value, price,
   currency }`. **The `package_id` is what you pass to create_invoice**, NOT
   the bare `value`.

3. **`bitrefill_get_balance()`** *(optional)* — when the user said "with my
   balance" or asked "can I afford it", verify the account has enough
   before creating the invoice. Skip when paying with Lightning / on-chain.

4. **`bitrefill_create_invoice({ products, payment_method, ... })`** —
   confirmation-gated spend. Choose `payment_method` per the user's request:
   - `"balance"` + `auto_pay: true` — instant settlement from account
     balance. **Default** when the user says "with my balance" or doesn't
     specify and balance is sufficient.
   - `"lightning"` — fastest crypto path. Response carries a BOLT11 invoice
     the user pays out-of-band. **Requires `refund_address`** in case it
     expires.
   - `"bitcoin"`, `"usdc_base"`, `"usdc_polygon"`, `"usdt_tron"`,
     `"usdt_ethereum"` — same pattern, slower confirmation; also need
     `refund_address`.

   Line items: `products: [{ product_id, package_id, quantity }]`. Up to 20
   per invoice.

5. **Settlement.**
   - With `payment_method:"balance"` + `auto_pay:true` the invoice is
     usually `complete` on creation — read its `order_id`(s) and go to
     step 6.
   - Otherwise relay the payment URI to the user and **poll**
     `bitrefill_get_invoice({ invoice_id })` until `status:"complete"`.
     Don't poll faster than every ~5s; give up after a few minutes and
     hand the invoice id back to the user to check later.

6. **`bitrefill_get_order({ order_id })`** — read `redemption_info`:
   - `.code` — the gift-card code or top-up PIN. The actual product.
   - `.pin` — additional PIN for prepaid cards (often present alongside
     the code).
   - `.link` — brand redemption URL when applicable.
   - `.instructions` — brand-specific redemption steps.

   Present the code in the chat ONCE, then tell the user to store it and
   redeem ASAP. Don't echo it in subsequent replies, summaries, or memory.

## Choosing a payment method

| Method | Speed | Blast radius | Use when |
|---|---|---|---|
| `balance` + `auto_pay:true` | Instant | Capped at account balance | Default. User pre-funded the account; lowest risk. |
| `lightning` | Seconds | Whatever's in the user's LN wallet | User asks for "pay with Lightning" or wants no pre-funding. |
| `bitcoin` | 10–60 min | One on-chain UTXO | User asks for "pay on-chain" or invoice > Lightning capacity. |
| `usdc_base` (x402) | Seconds | Agent USDC wallet balance | Agent has an x402-capable USDC wallet. |
| Other on-chain (USDT/USDC variants) | Variable | One UTXO per network | User explicitly requested. |

Default to `balance` when available; ask the user before switching to a
crypto method.

## Failure handling

Tool errors surface as thrown messages like `"bitrefill bitrefill_create_invoice failed: HTTP 401 ..."`. Relay them as plain English:

- **401 Unauthorized** — `BITREFILL_API_KEY` is unset or wrong. Tell the
  user; don't retry.
- **400 / validation errors** — usually a bad `package_id` or
  `payment_method`. Re-read the product's `packages` array and retry once,
  then stop and ask.
- **402 Payment Required** (with `balance`) — account underfunded. Show
  the deficit; suggest topping up or switching payment method.
- **Invoice `expired`** — re-create the invoice; an old quote isn't
  reusable.

## Reply style

- Show the candidate product list as a short bulleted list (≤5 rows).
- Before the spend, summarize in one line:
  `Buying: 1× Amazon US $25 — total $25.00 USD, paying with balance. Confirm?`
- After settlement: one line on success, then the redemption details on a
  separate line so the user can copy the code.
- After delivering the code, suggest redeeming ASAP and do NOT repeat the
  code in later turns.

## References (deep-dive, on demand)

The references below cover paths and host hardening — they're for hosts
that **don't** have the `bitrefill_*` tools wired (browser-only,
MCP-capable client, npm CLI, raw REST). When the tools above are
available, you don't need to read them.

| File | When |
|------|------|
| [api.md](references/api.md) | Mapping the contract tools back to raw REST endpoints. |
| [mcp.md](references/mcp.md) | Host has the Bitrefill remote MCP wired instead of the contract. |
| [cli.md](references/cli.md) | `@bitrefill/cli` npm path (auth-bound). |
| [cli-headless-auth.md](references/cli-headless-auth.md) | Magic-link auth via an agent inbox. |
| [browse.md](references/browse.md) | Browser-only hosts. |
| [host-openclaw.md](references/host-openclaw.md) | OpenClaw-specific path. |
| [capability-matrix.md](references/capability-matrix.md) | Per-client cheat sheet. |
| [safeguards.md](references/safeguards.md) | Spending policy + per-host hardening. |
| [troubleshooting.md](references/troubleshooting.md) | Common errors. |

## Source of truth

Skill describes the contract + playbook. For exhaustive enums (countries,
payment methods, full endpoint list), see <https://docs.bitrefill.com>.
