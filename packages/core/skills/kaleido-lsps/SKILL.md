---
name: kaleido-lsps
description: "Buy inbound Lightning channel capacity from a Lightning Service Provider (LSPS1). Quote a channel, estimate fees, place a channel order, and check order status. Triggers when the user wants inbound liquidity, says they can't receive a payment, needs a channel, asks about LSP fees, or wants to check the status of a channel order / LSP order."
tools: kaleidoswap_lsp_get_info, kaleidoswap_lsp_estimate_fees, kaleidoswap_lsp_create_order, kaleidoswap_lsp_get_order, kaleidoswap_lsp_quote_asset_channel, kaleidoswap_lsp_create_asset_channel, lsp_get_info, lsp_estimate_fees, lsp_create_order, lsp_get_order, rln_get_node_info, rln_pay_invoice
triggers: inbound, liquidity, channel order, lsp, lsps1, receive limit, can't receive, open channel, channel from, check status, order status, check the order, channel status, lsp status, check my channel
metadata:
  author: kaleidoswap
  version: "0.2.0"
---

# Lightning channel orders (LSPS1)

Buy inbound Lightning channel capacity from a Lightning Service Provider when
the user can't receive a payment, wants a bigger receive limit, or just wants
to open a new channel from the LSP. The host binds these to whichever LSP it
talks to — the KaleidoSwap maker by default. Tool names are LSP-agnostic
(`lsp_*`), so the same skill works against any LSPS1-compliant LSP.

## Critical rules — these override everything else

You have **no knowledge** of LSP capabilities, fees, channel sizes, or order
status. Every number, capacity, fee, order id, or invoice in your reply MUST
come from a tool result returned in the CURRENT turn. Never quote a fee from
memory. Never claim an order completed without calling `kaleidoswap_lsp_get_order`.
Never reuse a number from a previous turn.

**Calling the tool IS the answer.** Don't write "the LSP info is fetched with
`kaleidoswap_lsp_get_info`" — call it. Don't reveal tool names in your reply; describe
what you're doing in plain language.

If a tool needs a required argument the user didn't give (e.g. `client_pubkey`
when creating an order — get it from `rln_get_node_info`), resolve it via the
appropriate read tool. Don't ask the user for a pubkey.

## Asset codes

The same conventions as trading apply:
- `BTC` (sats) — the default for "inbound liquidity" / "channel capacity".
- `USDT` / `XAUT` — for RGB asset channels (uses `asset_id` + `lsp_asset_amount`).

## Tools and the flow

### Step 1 — `kaleidoswap_lsp_get_info`
No args. Returns the LSP's `OrderOptions` (min/max channel size, min/max
expiry, etc.) and the `assets` list. **Call it once before estimating** so you
can validate the user's request against the LSP's limits.

If the user wants 1M sats inbound but `max_initial_lsp_balance_sat` is 500k,
say so plainly and offer the maximum — don't push through and let the maker
reject it.

### Step 2 — `kaleidoswap_lsp_estimate_fees` (read-only)
Required args: `lsp_balance_sat`, `client_balance_sat`, `channel_expiry_blocks`.

Defaults you can use silently if the user didn't specify:
- `client_balance_sat: 0` (pure inbound order — most common)
- `channel_expiry_blocks: 4320` (~30 days)

Returns `{setup_fee, capacity_fee, duration_fee, total_fee}` — surface
`total_fee` to the user and the breakdown when relevant.

### Step 3 — `rln_get_node_info`
No args. Returns `{pubkey, ...}`. **Pubkey is required by `kaleidoswap_lsp_create_order` —
fetch it deterministically. Never invent a pubkey.**

### Step 4 — `kaleidoswap_lsp_create_order` 🔒 spend
Required args: `client_pubkey` (from step 3), `lsp_balance_sat`. The maker
also expects `client_balance_sat`, `required_channel_confirmations`,
`funding_confirms_within_blocks`, `channel_expiry_blocks`, `announce_channel`
— the host adapter fills sensible defaults (1, 6, 4320, true) when the user
didn't specify, so just pass the values the user actually named.

Returns:
- `order_id`
- `access_token` (save it — required for `kaleidoswap_lsp_get_order`)
- `payment.bolt11.invoice` — Lightning invoice to pay
- `payment.bolt11.order_total_sat` — the sats that need to flow
- `payment.onchain.address` — optional on-chain fallback
- `order_state: "CREATED"`

### Step 5 — Pay the invoice with `rln_pay_invoice`
Hand the `payment.bolt11.invoice` to `rln_pay_invoice`. This is a separate
spend gate at the wallet contract; the user confirms paying the LSP.

### Step 6 — `kaleidoswap_lsp_get_order` (poll)
**Args: `order_id`, `access_token` (BOTH required — never omit either).**
`order_state` progresses `CREATED → CHANNEL_OPENING → COMPLETED` (or `FAILED`).
Poll until terminal. Always pass the exact order_id and access_token from the
previous `kaleidoswap_lsp_create_order` result (or from the summary that listed them).
Report the outcome plainly with the new channel id from `channel.channel_id` if present.

## Don'ts

- Don't invent capacity, fees, pubkeys, order_ids, or invoices.
- Don't reuse a number from a previous turn — re-estimate when parameters
  change (different size or expiry).
- Don't describe how a tool works — call it.
- Don't pay a Lightning invoice without confirming the amount + LSP — the
  spend gate at `rln_pay_invoice` shows the user the destination.
- Don't claim an order completed without polling `kaleidoswap_lsp_get_order` with BOTH
  `order_id` and `access_token` and seeing `order_state: COMPLETED`.
- Never call `kaleidoswap_lsp_get_order` with only the access_token or only the order_id.
  Always extract the exact values from the previous turn's summary (the one that
  said "order_id=... access_token=...") and pass them as separate arguments.
- Don't ask the user for their node pubkey — fetch it from `rln_get_node_info`.

## When the deterministic recipe handles it

For requests like "I need 500k inbound" or "buy a channel from the LSP", the
`kaleidoswap-channel-order` recipe drives the whole chain (get_info →
estimate_fees → get_node_info → create_order → pay_invoice) with a single
confirmation gate showing the real fee. Use the agentic flow here only when
the recipe didn't fire — typically for read-only questions ("what does the
LSP offer?") or partial flows ("estimate fees for 200k inbound").
