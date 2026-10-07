---
name: kaleido-trading
description: "Trade on KaleidoSwap — quote and execute swaps between BTC and RGB assets (USDT, XAUT). Get assets and pairs, pull an executable quote, or run/poll an atomic swap end-to-end. Triggers when the user wants a quote, to swap or trade assets, to rebalance between BTC and stablecoins, or to check the status of a swap / atomic swap."
tools: kaleidoswap_get_assets, kaleidoswap_get_pairs, kaleidoswap_get_quote, kaleidoswap_atomic_init, kaleidoswap_atomic_execute, kaleidoswap_atomic_status, rln_get_node_info, rln_atomic_taker, rln_refresh_transfers, rln_get_asset_balance, rln_list_channels, rln_list_swaps, rln_get_swap
triggers: quote, swap, trade, rebalance, slippage, pair, pairs, usdt, xaut, kaleidoswap, rfq, check status, order status, check the order, swap status, check my swap, atomic status
metadata:
  author: kaleidoswap
  version: "0.5.0"
---

# KaleidoSwap trading

Quote and execute swaps on the KaleidoSwap maker. The model picks tools by
name; the host binds them through whichever transport it runs over (WDK on
mobile, HTTP/MCP/CLI on desktop).

## Critical rules — these override everything else

You have **no knowledge** of any price, quote, fee, pair, or order. Every
number, pair, or quote id in your reply MUST come from a tool result returned
in the CURRENT turn:

- "What pairs are listed?" → call `kaleidoswap_get_pairs` and list them.
- "Quote 100k sats to USDT" → call `kaleidoswap_get_quote(BTC, USDT, 100000)`,
  then state the receive amount + fee from the result.

**Calling the tool IS the answer.** Never write "the pairs are listed using
kaleidoswap_get_pairs" or "the function returns the quote" — just call it.

**Never reuse a number across turns.** If the user asks a new question, the
previous turn's quote, price, or fee is irrelevant — fetch fresh.

**Never invent a quote.** Without an `rfq_id` and a `to_asset.amount` returned
this turn, you do not have a quote. Say so and re-quote.

This skill is for tradeable pair quotes on the maker. It does NOT do generic
"what is bitcoin worth in USD" spot prices — that's the wallet's job. If the
user asks for a plain BTC price (not a swap), say you can quote a swap and ask
which pair + amount.

## Asset codes (canonical)

KaleidoSwap is the maker for **BTC ↔ RGB asset** atomic swaps. The asset
family is **RGB**: USDT, XAUT, and any other RGB asset the maker prices.
The RGB assets live on the user's **RLN** (RGB Lightning Node) — NOT on
Spark, Arkade, or any other chain.

Only these codes are accepted:

- `BTC` (Bitcoin, amounts always in satoshis)
- `USDT` (Tether, the RGB asset) — **not** `USD`, **not** `tether`
- `XAUT` (Tether Gold, the RGB asset) — **not** `XAU`, **not** `gold`

When the user types `USD` they almost always mean `USDT` — confirm before
quoting. Same for `gold` → `XAUT`. Don't silently substitute.

**Do NOT trade here:**

- `USDB` and any other **Spark-native token** — those are on the Spark
  layer and trade on **Flashnet** (skill: `flashnet-swaps`), not on
  KaleidoSwap. Route the user there instead of inventing a maker pair.
- Tokens from external chains (Ethereum USDT, Solana, etc.). They are
  not in the maker's catalog and the wallet does not custody them.

## Tools

### `kaleidoswap_get_pairs` — no args
Use when the user asks "what can I trade", "list pairs", "what's available",
or before quoting an unfamiliar pair.

### `kaleidoswap_get_quote` — REQUIRES `amount`
Required args: `from_asset` AND `to_asset` AND `amount`. The maker rejects a
quote that has no amount.

**If the user didn't give an amount, ASK for it. Do NOT call the tool with
from/to alone, and do NOT make up an amount.**

`amount` is in the smallest unit of `from_asset`. Use the EXACT number the user
typed (scaled if they used "k"/"m"/"M" shorthand: 100k → 100000, 2m → 2000000).
**Never** copy an amount from a previous turn or from these instructions.

Critical unit-and-leg anchor:
- If the user says **sats** or **satoshis** anywhere, the BTC leg is implied
  (sats = the smallest unit of BTC). `BTC` is always `from_asset` OR `to_asset`
  depending on the verb.
- "X sats TO Y" → `from_asset: "BTC"`, `to_asset: "Y"`, `amount: X-as-sats`.
- "X Y TO BTC" (Y ∈ {USDT, XAUT}) → `from_asset: "Y"`, `to_asset: "BTC"`,
  `amount: X-in-Y-units`.
- "buy Z of A with B" → spent = B → `from_asset: "B"`, received = A → `to_asset: "A"`,
  `amount: <amount of B the user wants to spend>`.
- "rate of X to Y" with NO number → no amount → ASK: "How much do you want to
  swap?" → do NOT call the tool yet.

### Reading the quote response

`kaleidoswap_get_quote` returns ready-to-read display fields — **use them
verbatim. Do NOT do any arithmetic yourself.** The response looks like:

```
{
  "rfq_id": "<id>",
  "from_amount_display": "100,000 BTC-sats",   ← what the user spends
  "to_amount_display":   "0.063176 USDT",       ← what the user receives
  "fee_display":         "0.000638 USDT",        ← the fee
  "expires_at": <epoch>,
  ...raw numeric fields you should ignore...
}
```

To state the answer, copy the strings:
- Receive amount → `to_amount_display`.
- Fee → `fee_display`.
- `rfq_id` is the quote handle (needed to start the atomic swap), short-lived (~60s) —
  mention it expires soon.

**Read `to_amount_display` / `fee_display` exactly as given.** Do NOT compute
`amount ÷ 10^precision`, do NOT restate the raw `price`/`amount` integers, and
do NOT copy the numbers from this document — they are placeholders. The only
correct numbers are the `*_display` strings in the CURRENT tool result.

A good reply: *"100,000 sats → <to_amount_display> (fee <fee_display>). Quote
<rfq_id> is valid ~60s — want me to place it?"*

### `kaleidoswap_atomic_init` 🔒 spend
Only after `kaleidoswap_get_quote` returned an `rfq_id` THIS turn, and only when
the user has explicitly approved the amount + direction. Starts the atomic
swap from that quote; the rest of the chain (`rln_atomic_taker` →
`kaleidoswap_atomic_execute` → `kaleidoswap_atomic_status`) is described
below and in `references/atomic.md`.

### `kaleidoswap_atomic_status`
Poll after executing an atomic swap until it reaches a terminal state
(completed / failed / expired). Pass the exact ids returned by
`kaleidoswap_atomic_init` (or surfaced in the most recent swap summary) — never
invent them. Report the outcome plainly.

## Flow

1. **Pick a pair** — skip when obvious (`BTC/USDT`, `BTC/XAUT`).
2. **Quote** — `kaleidoswap_get_quote`. REQUIRES amount; ask if missing.
3. **Read + present** — compute the receive amount + fee from the response (see
   "Reading the quote response"). **Never hide cost.**
4. **Swap** — `kaleidoswap_atomic_init` → `rln_atomic_taker` →
   `kaleidoswap_atomic_execute`. Spend-gated by the engine; the host pauses for
   the user.
5. **Track** — poll `kaleidoswap_atomic_status` with the ids from
   `kaleidoswap_atomic_init` until it terminates.

## Don'ts

- Don't invent prices, quotes, rfq_ids, swap ids, or access_tokens.
- Don't reuse a number from a previous turn.
- Don't describe how a tool works — call it.
- Don't call `kaleidoswap_get_quote` with from/to only — ask for the amount.
- Don't make up an amount the user didn't give.
- Don't do unit math or restate raw integers — read the `*_display` strings.
- Don't copy numbers from the skill docs — only the current tool result is real.
- Don't accept `XAU` as `XAUT` or `USD` as `USDT` silently — confirm.
- Don't retry the same failing tool call in a loop. If a call fails, read the
  error and either ask the user, fix the args, or stop.
- Don't claim a swap completed without polling `kaleidoswap_atomic_status`
  and seeing a terminal state.

For the full atomic-swap flow (init → whitelist on the RGB node → execute), a
deterministic recipe drives the chain — the agentic loop is not safe to plan a
multi-step, two-service swap on a small model. Status for atomics uses the
`atomic_id` (or payment_hash) surfaced in the recipe summary.

## Over kaleido-mcp (desktop, Claude Code)

kaleido-mcp 0.3.0+ is **atomic-only**. Its quote takes `from_asset_id` / `from_layer` /
`from_amount` (display units) and returns `amount_raw` values that
`kaleidoswap_atomic_init` takes unchanged. The full chain is quote →
`kaleidoswap_atomic_init` → `rln_atomic_taker` + `rln_get_node_info` →
`kaleidoswap_atomic_execute` → poll `kaleidoswap_atomic_status` →
`rln_refresh_transfers`. Read `references/atomic.md` before the first swap,
and `references/assets.md` for units and precision. Always follow the
argument names in the tool schema you were given.

