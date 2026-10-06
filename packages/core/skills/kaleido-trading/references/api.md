# KaleidoSwap maker API (what the tools call)

Base URLs: `https://api.kaleidoswap.com` (mainnet),
`https://api.signet.kaleidoswap.com` (signet, `KALEIDO_NETWORK=signet` in
kaleido-mcp). The MCP tools wrap these endpoints; you normally never call them
directly. Amounts on the wire are raw units (see `assets.md`).

| Endpoint | Tool |
|---|---|
| `GET /api/v1/market/assets` | `kaleidoswap_get_assets` |
| `GET /api/v1/market/pairs` | `kaleidoswap_get_pairs` |
| `POST /api/v1/market/quote` | `kaleidoswap_get_quote` |
| `POST /api/v1/swaps/init` | `kaleidoswap_atomic_init` |
| `POST /api/v1/swaps/execute` | `kaleidoswap_atomic_execute` |
| `POST /api/v1/swaps/atomic/status` | `kaleidoswap_atomic_status` |
| `GET /api/v1/lsps1/get_info` | `kaleidoswap_lsp_get_info` |
| `POST /api/v1/lsps1/estimate_fees` | `kaleidoswap_lsp_estimate_fees` |
| `POST /api/v1/lsps1/create_order` | `kaleidoswap_lsp_create_order` |
| `POST /api/v1/lsps1/get_order` | `kaleidoswap_lsp_get_order` |

## Pairs

```json
[{
  "base":  { "ticker": "BTC",  "precision": 11 },
  "quote": { "ticker": "USDT", "precision": 6 },
  "routes": [
    { "from_layer": "BTC_LN", "to_layer": "RGB_LN", "min_amount": 50000,   "max_amount": 10000000000 },
    { "from_layer": "RGB_LN", "to_layer": "BTC_LN", "min_amount": 1000000, "max_amount": 999999000000 }
  ]
}]
```

`min_amount` / `max_amount` are raw units of the route's `from` asset.

## Quote

```json
{
  "rfq_id": "uuid", "expires_at": "2026-01-01T00:01:00Z",
  "from_asset": { "ticker": "BTC",  "layer": "BTC_LN", "amount_raw": 100000000, "amount_display": 0.001 },
  "to_asset":   { "ticker": "USDT", "layer": "RGB_LN", "amount_raw": 65763000,  "amount_display": 65.763 },
  "price": 65763.0
}
```

## Swap

- `init` → `{ swapstring, payment_hash, access_token }` (`access_token` only here)
- `execute` takes `{ swapstring, taker_pubkey, payment_hash }`
- `status` takes `{ payment_hash, access_token }` →
  `{ swap: { status: "Waiting" | "Pending" | "Succeeded" | "Expired" | "Failed" } }`

## LSPS1 orders

`estimate_fees` / `create_order` take `{ client_pubkey, lsp_balance_sat,
client_balance_sat, channel_expiry_blocks }`. `create_order` returns
`{ order_id, bolt11_invoice, order_total_sat }`; `get_order` reports
`PENDING → CHANNEL_OPENING → COMPLETED | FAILED`. Good defaults:
`lsp_balance_sat = 500000`, `client_balance_sat = 0`,
`channel_expiry_blocks = 4320`.
