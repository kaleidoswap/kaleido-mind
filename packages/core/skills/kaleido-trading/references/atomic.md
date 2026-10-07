# Atomic swap

Every KaleidoSwap swap settles as an atomic HTLC swap between the maker and
the user's RGB Lightning Node (RLN). There is no deposit or order flow. If either side fails, nothing settles. Typical end-to-end
time: 2–15 s.

The argument names are the same in kaleido-mcp and in the `@kaleidorg/mind`
KaleidoSwap contract.

## Steps

```
0. kaleidoswap_get_pairs()    → pairs + routes[{ from_layer, to_layer, min_amount, max_amount }]
   kaleidoswap_get_assets()   → asset_id + precision per ticker (ids differ per network)

1. kaleidoswap_get_quote({
     from_asset_id: "BTC",  from_layer: "BTC_LN",  from_amount: 0.001,   // display units
     to_asset_id:   "<USDT asset_id>",  to_layer: "RGB_LN"
   })
   → { rfq_id, expires_at, from_asset: { amount_raw, amount_display },
       to_asset: { amount_raw, amount_display }, price }
   Pass exactly one of from_amount (sell a fixed input) or to_amount (buy a fixed output).
   Show the user amount in → amount out → rate, and wait for a yes.

2. kaleidoswap_atomic_init({ rfq_id,
     from_asset_id, from_amount_raw: quote.from_asset.amount_raw,
     to_asset_id,   to_amount_raw:   quote.to_asset.amount_raw })
   → { swapstring, payment_hash, access_token }
   access_token is returned only here; keep it for status.

3. rln_atomic_taker({ swapstring })      ← whitelist the incoming HTLC. MUST precede execute.
   rln_get_node_info()                   → { pubkey }  (the taker_pubkey)

4. kaleidoswap_atomic_execute({ swapstring, taker_pubkey, payment_hash })

5. kaleidoswap_atomic_status({ payment_hash, access_token })   ← poll every 2 s
   Waiting → Pending → Succeeded | Failed | Expired

6. rln_refresh_transfers()               ← after an RGB leg, so balances update
```

`amount_raw` values are already in the maker's raw units (msat for BTC, atomic
units for RGB). Never convert them again. `payment_hash` identifies the swap
and is not an order id.

## Errors

| Situation | What to do |
|---|---|
| Quote expired (~60 s) | Re-quote. Never reuse an rfq_id or swapstring. |
| `rln_atomic_taker` fails | Do NOT execute. Re-quote and restart. |
| Status `Expired` / `Failed` | Nothing settled. Check liquidity on both legs (`rln_list_channels`), then re-quote. |
| Polling > 120 s | Check `rln_get_swap({ payment_hash, taker: true })` before retrying. Never start a second swap for the same trade while one may still settle. |

## Liquidity prerequisites

The swap needs outbound capacity on the asset you send and inbound capacity on
the asset you receive. If either side is short, `atomic_execute` fails. Buy a
channel first (skill: `channel-manager`).

## Reading the result

An RGB asset received into a Lightning channel shows up in
`rln_get_asset_balance({ asset_id }).offchain_outbound`, not in `spendable`
(which is on-chain only). `offchain_outbound + offchain_inbound` is the
channel's capacity for that asset. The node's own view of swaps:
`rln_list_swaps()` / `rln_get_swap({ payment_hash, taker: true })`.

## Cross-layer moves

| From | To | How |
|---|---|---|
| BTC_LN | RGB_LN (USDT/XAUT) | atomic swap |
| RGB_LN | BTC_LN | atomic swap |
| RGB_LN | RGB_LN (e.g. XAUT → USDT) | atomic swap |
| BTC_LN | BTC_SPARK | not a swap: create a Spark Lightning invoice, pay it from the node (`rln_pay_invoice`) |
| BTC_SPARK | BTC_LN | create an invoice on the node (`rln_create_ln_invoice`), pay it from Spark |
| BTC_LN | BTC_L1 | close a channel (`rln_close_channel`), slow |

Other layers can appear in `kaleidoswap_get_pairs()` routes but are not
executable through these tools.

## Safety

1. Confirm from / to / amount / rate before `atomic_init`.
2. Never hard-code asset ids or layers; read them from the API.
3. Re-quote if execution would start more than ~30 s after the quote.
4. Check `rln_list_swaps()` for a pending taker swap before starting another.
5. Dry run: when asked for a dry run, quote and report only; never call
   `kaleidoswap_atomic_init`, `rln_atomic_taker`, `kaleidoswap_atomic_execute`,
   `rln_send_asset` or `rln_pay_invoice`.
