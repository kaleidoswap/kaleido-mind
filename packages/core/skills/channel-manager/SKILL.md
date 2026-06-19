---
name: channel-manager
description: "Keep the Lightning node healthy: check node info, audit channels and liquidity, flush stuck RGB transfers, and (when allowed) buy inbound/asset channel capacity via the KaleidoSwap LSP. Triggers when the user asks about node health, channels, liquidity, or inbound capacity — and is the skill the scheduled 'heartbeat' loop runs."
tools: rln_get_node_info, rln_list_channels, rln_get_balances, rln_list_assets, rln_refresh_transfers, kaleidoswap_lsp_get_info, kaleidoswap_lsp_estimate_fees, kaleidoswap_lsp_create_order, rln_pay_invoice
triggers: node, channel, channels, liquidity, inbound, outbound, lsp, heartbeat, health, transfers, stuck
metadata:
  author: kaleidoswap
  version: "0.1.0"
---

# Channel manager

Keep the RGB Lightning node healthy and liquid. Read state every run; only buy
capacity when the user allows it and it's actually needed.

## Critical rules — these override everything else

- **Diagnose before acting.** `rln_get_node_info` + `rln_list_channels` +
  `rln_get_balances` first. Report what you see; don't guess.
- **Respect `dry_run`.** When true, describe the action you *would* take (e.g.
  "buy 1M sat inbound") but do NOT call `kaleidoswap_lsp_create_order` or
  `rln_pay_invoice`.
- **Buying capacity is a spend** — it routes through the host's risk gate. Never
  propose one that breaches the BTC reserve, and always show the LSP fee
  (`kaleidoswap_lsp_estimate_fees`) before recommending it.

## Health checks (run in order)

1. **Node up?** `rln_get_node_info` — pubkey, block height, synced.
2. **Channels.** `rln_list_channels` — count, capacity, outbound vs inbound. Flag
   any channel whose outbound is below the configured floor.
3. **Stuck transfers.** `rln_refresh_transfers` to flush pending RGB transfers;
   report anything still pending afterward.
4. **Liquidity verdict.** If usable inbound (or an asset's inbound) is below the
   threshold in the task parameters, that's the trigger to consider buying.

## Buying capacity (only when needed + allowed)

1. `kaleidoswap_lsp_get_info` — confirm the LSP is reachable + its limits.
2. `kaleidoswap_lsp_estimate_fees` — show the fee for the size you'd buy.
3. `kaleidoswap_lsp_create_order` (spend-gated) — create the order; it returns an
   invoice/onchain address. Pay via `rln_pay_invoice` only after approval.

## Scheduled (background) runs

When run by the `heartbeat` loop, return STRICT JSON only:

```
{"task":"heartbeat","timestamp":"<ISO8601>","action":"ok|flush|buy_capacity|alert","dry_run":<bool>,"reason":"<why>","details":{"channels":<n>,"outbound_sat":<n>,"inbound_sat":<n>,"pending_transfers":<n>}}
```

Use `ok` when nothing needs doing, `alert` when a human should look.

## Don'ts

- Don't buy capacity that isn't needed, or when within the liquidity threshold.
- Don't pay an LSP invoice when `dry_run` is true.
- Don't invent channel ids, balances, or fees — read them from tools.
- Don't breach the BTC reserve to open a channel.
