---
name: merchant-finder
description: "Find places that accept Bitcoin (shops, restaurants, cafes, bars, ATMs) near the user or in a named city, from live BTC Map data."
tools: find_merchant_locations, search_knowledge
requires-tools: find_merchant_locations
triggers: merchant, merchants, shop, shops, store, restaurant, restaurants, cafe, cafes, coffee, bar, bars, atm, atms, near me, nearby, where can i spend, accept bitcoin, pizza, food, eat, btcmap, bitcoin map
metadata:
  author: kaleidoswap
  version: "0.4.0"
  homepage: "https://btcmap.org"
---
# Merchant finder

Every place in a reply comes from `find_merchant_locations` in this turn. The
data is already Bitcoin-only.

## Do
- Pass the fewest arguments that express the request:
  - `near_address` when the user names a place; omit it for "near me".
  - `category` only for a clear venue type: `restaurant`, `cafe`, `bar`,
    `shop`, `grocery`, `lodging`, `atm`.
  - `query` for a food or name ("pizza", "coffee"). Never "sats", "btc",
    "bitcoin" or "spend".
  - `radius_km` / `limit` only when the user gave a distance or count.
- List the results, one line each: name, category, address, distance, and
  whether Lightning is accepted. Up to about 8.
- `{success:false, error}` → relay the error and stop.
- `search_knowledge` may add background from a loaded merchant corpus.

## Examples
- "Where can I spend sats in Turin?" → `find_merchant_locations {"near_address":"Turin"}`
- "Cafes in Lisbon" → `find_merchant_locations {"category":"cafe","near_address":"Lisbon"}`
- "Pizza near me that takes bitcoin" → `find_merchant_locations {"query":"pizza"}`
- "Bitcoin ATMs within 2 km" → `find_merchant_locations {"category":"atm","radius_km":2}`
