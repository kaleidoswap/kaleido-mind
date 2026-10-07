# Assets, units and precision

Asset ids differ between signet and mainnet and may rotate on signet. Always
discover them with `kaleidoswap_get_assets()` (cache for at most ~5 minutes);
never hard-code them.

```json
{ "asset_id": "BTC" | "rgb:...", "ticker": "USDT", "name": "...", "precision": 6 }
```

Some environments omit BTC from the assets list; `kaleidoswap_get_pairs()`
always includes it.

## Units

BTC uses **millisatoshis** as its raw unit (precision 11):

```
1 BTC     = 100,000,000 sats = 1e11 msat
0.001 BTC =     100,000 sats = 1e8 msat
1 sat     = 1,000 msat
```

RGB assets use their own precision:

```
raw     = round(display × 10^precision)
display = raw / 10^precision
```

| Asset | Typical precision | Raw unit |
|---|---|---|
| BTC | 11 | msat |
| USDT | 6 | micro-USDT |
| XAUT | 9 | nano-XAUT |

Read precision from the API; the table is illustrative.

## Which unit each tool takes

| Tool | Units |
|---|---|
| `kaleidoswap_get_quote` | display (`0.001` BTC, `65.0` USDT) |
| `kaleidoswap_atomic_init` | raw: pass `quote.*.amount_raw` unchanged |
| `rln_send_asset` / `rln_create_rgb_invoice` / `rln_issue_asset` | display units |
| `rln_list_assets` / `rln_get_asset_balance` balances | raw: divide by 10^precision |

## Mapping user words

- "BTC" over Lightning → `asset_id: "BTC"`, layer `BTC_LN`; on-chain → `BTC_L1`.
- "USDT" → the asset whose `ticker === "USDT"`. "USD" usually means USDT: confirm.
- "gold" / "XAUT" → `ticker === "XAUT"`. Confirm "gold".

## Layers

`BTC_L1`, `BTC_LN`, `BTC_SPARK`, `BTC_ARKADE`, `RGB_L1`, `RGB_LN`. Use the
values from `kaleidoswap_get_pairs()` routes verbatim.
