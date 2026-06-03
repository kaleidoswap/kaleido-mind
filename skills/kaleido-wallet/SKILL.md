---
name: kaleido-wallet
description: "Manage a KaleidoSwap Lightning + RGB wallet: check BTC and asset balances, get a receive address, create or pay Lightning invoices, send on-chain BTC, open or list channels. Triggers when the user asks about their balance, wants to receive or send funds, pay an invoice, or manage Lightning channels."
tools: wdk_get_balances, wdk_get_asset_balance, wdk_get_address, wdk_create_ln_invoice, wdk_pay_invoice, wdk_send_btc, wdk_list_channels, wdk_open_channel, wdk_get_node_info
triggers: balance, receive, address, send, pay, invoice, channel, deposit, withdraw, funds
metadata:
  author: kaleidoswap
  version: "0.1.0"
  surface: "kaleido-mcp (WDK node)"
---

# KaleidoSwap wallet

Operate the user's KaleidoSwap node (Lightning + RGB assets) through the
`wdk_*` MCP tools.

## Rules

- **Read before you write.** Check the balance (`wdk_get_balances`) before any
  send or channel open, and confirm the node is healthy (`wdk_get_node_info`).
- **Confirm every spend.** State the amount, destination, and resulting balance,
  then wait for explicit approval before calling `wdk_send_btc`,
  `wdk_pay_invoice`, or `wdk_open_channel`.
- **Match the rail to the asset.** Lightning for fast BTC/asset payments,
  on-chain for settlement or channel funding. Use `wdk_get_asset_balance` for
  RGB assets (USDT, XAUT, …).
- Never reveal seeds or private keys — this skill operates a node, it is not a
  key vault.
