---
name: merchant-finder
description: "Find Bitcoin-accepting merchants near the user using live BTC Map data and the device's real location. Triggers when the user asks where to spend Bitcoin, for a shop, store, restaurant, cafe, bar, or ATM that accepts Bitcoin, or for merchants nearby."
tools: find_merchant_locations, get_merchant_info
triggers: merchant, shop, store, restaurant, cafe, bar, atm, accept, nearby, near me, around, where, place, spend, bitcoin map, btcmap
metadata:
  author: kaleidoswap
  version: "0.2.0"
  homepage: "https://btcmap.org"
---

# Merchant finder

Discover places that accept Bitcoin payments — cafés, restaurants, bars, shops,
and ATMs. Live BTC Map data when the host injects a fetcher + location;
otherwise a small offline list keeps the skill answerable.

## Critical rule — never answer from memory

You have **no knowledge of any merchant**. Every place, name, address and
distance in your reply MUST come from a `find_merchant_locations` result
returned in the CURRENT turn. **Call `find_merchant_locations` for every
place question**, even if a similar question was answered earlier — do NOT
reuse or adapt a previous answer. Never invent a merchant.

## How to call the tools

1. **Start with `find_merchant_locations`.** Pass ONLY the fields the user
   actually named — do not invent constraints:
   - `query` — a specific thing the user named (e.g. "tapas", "coffee"). Omit
     when they only said "near me" or only named a place.
   - `category` — one of `restaurant`, `cafe`, `bar`, `shop`, `grocery`,
     `lodging`, `atm`. Only when they named a type.
   - `near_address` — a city or address to search around instead of the
     device's location.
   - `radius_km` — 0.25–50, default 5.
   - `limit` — 1–20, default 10.

   Examples:
   - "where can I spend btc near me" → `find_merchant_locations({})`
   - "cafes in Lisbon" → `find_merchant_locations({ category: "cafe", near_address: "Lisbon" })`
   - "lightning bars in NYC, within 2 km" → `find_merchant_locations({ category: "bar", near_address: "New York", radius_km: 2 })`

2. **Present the results.** Each row carries:
   - `name`, `category`, `address`
   - `distance_m` when present — show in metres or km
   - `accepts_bitcoin` / `accepts_lightning` — relevant because Lightning is
     fastest for small payments
   - `phone`, `website`, `opening_hours` when present — surface if asked

3. **Use `get_merchant_info` only when** the user asks for more detail on one
   specific result. Pass `merchant_id` (preferred) or `merchant_name`.

## Reply style

- Be concise. One line per merchant works:
  `Name — category, address (X m away, accepts: lightning, onchain)`.
- If the result `source` is `offline`, say so plainly — it means the live
  BTC Map fetch wasn't available, so the list is limited.
- If `find_merchant_locations` returns zero merchants, say so — don't invent
  places. Suggest widening `radius_km` or trying `near_address`.
- When the user says "near me" and `precise_location` is false, mention which
  fallback location was used so they know it's not their actual GPS.
