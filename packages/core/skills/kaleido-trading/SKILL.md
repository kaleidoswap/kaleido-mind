---
name: kaleido-trading
description: "Trade on KaleidoSwap — quote and execute swaps between BTC and RGB assets (USDT, XAUT). Get assets and pairs, pull an executable quote, place a market order, or track an atomic swap end-to-end. Triggers when the user wants a price, a quote, to swap or trade assets, or to rebalance between BTC and stablecoins."
tools: get_price, fiat_to_sats, kaleidoswap_get_assets, kaleidoswap_get_pairs, kaleidoswap_get_quote, kaleidoswap_get_nodeinfo, kaleidoswap_place_order, kaleidoswap_get_order_status, kaleidoswap_get_order_history
triggers: price, quote, swap, trade, rebalance, market, slippage, exchange, convert, sell, buy
metadata:
  author: kaleidoswap
  version: "0.2.0"
---

# KaleidoSwap trading

Quote and execute swaps on the KaleidoSwap maker. The model picks tools by
name; the host binds them through whichever transport it runs over (WDK on
mobile, HTTP/MCP/CLI on desktop). The schemas are identical everywhere — only
the binder differs.

## Flow (market-order path)

1. **Pick a pair.** If the user names assets you don't have inventory for,
   call `kaleidoswap_get_assets` / `kaleidoswap_get_pairs` first. Skip these
   when the pair is obviously supported (BTC/USDT, BTC/XAUT).
2. **Quote.** Call `kaleidoswap_get_quote` with `from_asset`, `to_asset`,
   `amount` (and `side` if not the default "sell"). Returns a quote id, the
   expected receive amount, fees, slippage, and TTL. Re-quote rather than
   reusing a stale id.
3. **Show + confirm.** State pair, direction, amount in, expected amount out,
   fees, and slippage. The next step is spend-gated by the engine, but the
   user benefits from seeing the full picture before they approve.
4. **Place.** Call `kaleidoswap_place_order` with the quote id. The engine
   pauses for explicit confirmation before the maker is called.
5. **Track.** Poll `kaleidoswap_get_order_status` until it terminates
   (completed / failed). Report the outcome plainly.

## Rules

- **Re-quote on hesitation.** Quotes expire; a stale id will be rejected.
- **Never hide cost.** Always surface fees and slippage — a small local model
  must not abbreviate them out of the message.
- **Don't invent prices or pair availability.** Tool result is the truth; if
  a pair isn't quoted, say so instead of guessing.
- **Fiat amounts → sats first.** When the user gives a fiat figure ("buy 50
  EUR of USDT"), use `get_price` + `fiat_to_sats` to get the BTC amount before
  quoting. Don't ask the small model to do the math.

For the atomic-swap flow (when the user wants a trust-minimised cross-asset
swap that the maker can't simply settle through their balance), use the
dedicated atomic recipe — the agentic chain is not safe to plan on a 0.6B.
