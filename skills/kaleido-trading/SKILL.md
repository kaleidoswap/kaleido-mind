---
name: kaleido-trading
description: "Trade and manage a portfolio on KaleidoSwap: get live prices and market data, quote and place atomic swaps between BTC and RGB assets (USDT, XAUT), acquire inbound liquidity from the LSP, and check positions. Triggers when the user wants a price, a quote, to swap or trade assets, to rebalance a portfolio, or to acquire a Lightning channel from the LSP."
tools: get_price, get_market_data, kaleidoswap_get_pairs, kaleidoswap_get_quote, kaleidoswap_place_order, kaleidoswap_get_order_status, kaleidoswap_get_position, kaleidoswap_lsp_get_info, kaleidoswap_lsp_create_order
triggers: price, quote, swap, trade, rebalance, portfolio, market, slippage, liquidity, channel order
metadata:
  author: kaleidoswap
  version: "0.1.0"
  surface: "kaleido-mcp (KaleidoSwap maker + market data)"
---

# KaleidoSwap trading

Quote, swap, and manage a portfolio through the KaleidoSwap maker and market
data MCP tools.

## Flow

1. **Price first.** Use `get_price` / `get_market_data` for context and
   `kaleidoswap_get_quote` for an executable price before proposing a trade.
2. **Confirm the trade.** Show pair, direction, amount in, expected amount out,
   and fees. Wait for explicit approval before `kaleidoswap_place_order`.
3. **Track it.** After placing, poll `kaleidoswap_get_order_status` until the
   swap settles, then report the result and the new `kaleidoswap_get_position`.
4. **Need inbound liquidity?** If a swap can't route for lack of a channel, use
   `kaleidoswap_lsp_get_info` then `kaleidoswap_lsp_create_order` to buy one.

## Rules

- Never trade on a stale quote — re-quote if the user hesitates.
- Surface slippage and fees explicitly; small local models must not hide cost.
