---
name: merchant-finder
description: "Find Bitcoin-accepting merchants near the user using live BTC Map data and the device's real location. Triggers when the user asks where to spend Bitcoin, for a shop, store, restaurant, cafe, bar, or ATM that accepts Bitcoin, or for merchants nearby."
tools: find_merchant_locations
triggers: merchant, merchants, shop, shops, store, stores, restaurant, restaurants, cafe, cafes, bar, bars, atm, atms, accept, accepts, accepting, nearby, near me, around, place, places, spend, find, pizza, food, coffee, bitcoin map, btcmap
metadata:
  author: kaleidoswap
  version: "0.2.0"
  homepage: "https://btcmap.org"
---

# Merchant finder

Discover places that accept Bitcoin payments — cafés, restaurants, bars, shops,
and ATMs. **Live BTC Map data only** — when the host has not injected a fetcher
or cannot resolve a location, the tool returns `{success:false, error}`; relay
that error to the user verbatim instead of inventing places.

## Critical rules (read first)

1. **Never answer from memory.** You have NO knowledge of any merchant. Every
   place, name, address and distance in your reply MUST come from a
   `find_merchant_locations` result returned in the CURRENT turn. Call
   `find_merchant_locations` for every place question, even if a similar one
   was answered earlier — do NOT reuse a previous answer. Never invent a
   merchant.
2. **List, don't pick.** A "where can I…" / "find merchants" question is a
   LIST question. Show every merchant the tool returned (cap at the first ~5
   if there are many), ONE LINE EACH. Never collapse a list of 10 to one
   example. The host's "keep replies short" guidance applies to prose, not to
   a list the user explicitly asked for.
3. **Never invent arguments.** When in doubt, pass FEWER fields. "Spend btc in
   Lugano" → `{near_address:"Lugano"}` — that's the whole call. Adding a
   category you guessed at filters out most results.

## How to call the tools

1. **Start with `find_merchant_locations`.** Pass ONLY the fields the user
   actually named — do not invent constraints:

   - `query` — a specific thing the user named (e.g. `"tapas"`, `"coffee"`,
     `"pizza"`). Omit when they only said "near me" or only named a place.

   - `category` — must be EXACTLY one of: `restaurant`, `cafe`, `bar`, `shop`,
     `grocery`, `lodging`, `atm`. **Anything else is invalid — leave it empty.**
     The words "merchant", "merchants", "place", "places", "store", "stores"
     are NOT categories — they're the generic noun for what you're searching
     for, so they belong in `query` at best, never in `category`.

   - `near_address` — a city, neighbourhood, or address (e.g. `"Milan"`,
     `"Bitcoin Beach, El Salvador"`). Use this any time the user names a
     location instead of "near me".

   - `radius_km` — **omit unless the user names a specific number.** The
     default (5 km) is a sensible search radius for a city. Don't pick a
     small radius (1, 2, 3) yourself — city-wide searches need 5+.

   - `limit` — 1–20, default 10. Omit unless the user names a count.

   Examples (positive):
   - "where can I spend btc near me" → `find_merchant_locations({})`
   - "where can I spend btc in Lugano" →
     `find_merchant_locations({ near_address: "Lugano" })`
     ↑ "spend btc" = ANY merchant. NO `category`. NO `radius_km`. Only the city.
   - "find merchants in Milan" → `find_merchant_locations({ near_address: "Milan" })`
     ↑ no `category` — "merchants" is NOT a category.
   - "cafes in Lisbon" → `find_merchant_locations({ category: "cafe", near_address: "Lisbon" })`
   - "pizza places in Switzerland that take bitcoin" →
     `find_merchant_locations({ query: "pizza", near_address: "Switzerland" })`
     ↑ "places" is NOT a category — pizza goes in `query`.
   - "lightning bars in NYC, within 2 km" →
     `find_merchant_locations({ category: "bar", near_address: "New York", radius_km: 2 })`
     ↑ user explicitly said "2 km" → set radius_km.

   Examples (anti — do NOT do these):
   - ❌ `category: "merchant"` (not a category)
   - ❌ `category: "place"` (not a category)
   - ❌ `category: "restaurant"` when the user said "spend btc" without naming
     food — "spend btc" means ANY merchant, not specifically a restaurant.
     Adding a category you invented will exclude shops, cafés and ATMs.
   - ❌ `query: "btc"` or `query: "bitcoin"` — every merchant in this database
     already accepts Bitcoin, so filtering by "btc" returns NOTHING. "Btc"
     is the *thing being spent*, not a merchant name. Omit `query` for
     generic "spend btc" / "places to spend bitcoin" requests.
   - ❌ `radius_km: 2` when the user didn't say "2 km" — you're picking a
     too-small radius and the result will be empty.
   - ❌ `radius_km: 5` "just to be safe" — the default IS 5; omit it entirely
     unless the user named a different number.

2. **Present the results.** Each row carries:
   - `name`, `category`, `address`
   - `distance_m` when present — show in metres or km
   - `accepts_bitcoin` / `accepts_lightning` — relevant because Lightning is
     fastest for small payments
   - `phone`, `website`, `opening_hours` when present — surface if asked

3. **Handling failures.** If the tool returns `{success:false, error}`, relay
   the error as-is and stop. Common cases:
   - "Merchant search is unavailable…" → the host has no BTC Map adapter.
   - "Could not locate \"X\"…" → geocoding failed; ask the user for a nearby
     city or check the spelling.
   - "Could not determine your location…" → no `near_address` was passed and
     the device has no GPS / default location.

   Do NOT retry with invented data, and do NOT pretend you know merchants in
   the area. There is no offline fallback — a failure means no data.

## Reply style

- **List, don't summarize.** A place-finding question expects a LIST — show
  every merchant the tool returned (or the first ~5 when there are many),
  one line each. Never collapse a list of 10 places to one example. "Keep
  replies short" applies to prose, not to a list the user explicitly asked
  for.
- One line per merchant:
  `Name — category, address (X m away, accepts: lightning, onchain)`.
- If `find_merchant_locations` returns zero merchants, say so — don't invent
  places. Suggest widening `radius_km` or trying `near_address`.
- When the user says "near me" and `precise_location` is false, mention which
  fallback location was used so they know it's not their actual GPS.
