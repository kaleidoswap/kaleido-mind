---
name: btc-map
description: "Find merchants that accept Bitcoin from the BTC Map directory — cafés, restaurants, bars, and shops with Lightning, on-chain, or stablecoin payments. Triggers when the user asks where they can spend Bitcoin, find a Lightning café, discover Bitcoin-friendly places nearby, or look up a specific city (Lugano, Lisbon, El Zonte, Prague, Amsterdam, NYC)."
tools: find_merchants, get_merchant_info
triggers: btc map, btcmap, merchants, merchant, spend bitcoin, lightning cafe, lightning café, places, near me, where can i, accept bitcoin, accepts bitcoin, accepts lightning
metadata:
  author: kaleidoswap
  version: "0.1.0"
  homepage: "https://btcmap.org"
---

# BTC Map

Discover places that accept Bitcoin payments — from a small bundled directory of Lightning-friendly cafés, restaurants, bars, and shops across Lugano, Lisbon, El Zonte (El Salvador), New York, Prague, and Amsterdam.

## When to use

Use this skill when the user wants to:
- Find a place to spend Bitcoin in a specific city.
- Discover Lightning-friendly cafés, bars, or restaurants.
- Look up whether a merchant accepts Lightning, on-chain BTC, or stablecoins.

Do **not** use this skill for: payments themselves (use the wallet/payments skill once the user picks a place), price lookups, or directions.

## Critical rule — never answer from memory

You have **no knowledge of any merchant**. Every place, name, address, and city
in your answer MUST come from a `find_merchants` result returned in the CURRENT
turn. **Call `find_merchants` for every place question**, even if a similar
question was answered earlier in this conversation — do NOT reuse or adapt a
previous answer. If you have not called `find_merchants` this turn, you have no
data and must call it before replying. Never invent a merchant.

## How to call the tools

1. **Start with `find_merchants`.** Pass ONLY the fields the user actually named — do not invent constraints:
   - `query` — a specific thing the user named (e.g. "tapas"). **Omit it** when the user only gave a city or a general "where can I spend BTC".
   - `city` — narrow to one city (e.g. "Lugano", "Lisbon"). Optional.
   - `category` — one of `cafe`, `restaurant`, `bar`, `shop`. Set only when the user names a type.
   - `k` — how many results, default 5.

   Examples:
   - "where can I spend btc in lugano" → `find_merchants({ city: "Lugano" })`
   - "find tapas in lisbon" → `find_merchants({ city: "Lisbon", query: "tapas" })`
   - "any bitcoin bars in NYC?" → `find_merchants({ city: "New York", category: "bar" })`

2. **Present the results.** Each result is one merchant. Always include:
   - Name and category.
   - City + address.
   - Which assets they accept (`accepts: [lightning, onchain, …]`) — relevant because Lightning is fastest for small payments.

3. **Use `get_merchant_info(id)` only when** the user asks for more detail on one specific result (full description, coordinates for navigation).

## Reply style

- Be concise. One line per merchant: `Name — category, city, address (accepts: …)`.
- If `find_merchants` returns zero results, say so plainly — don't invent places.
- When the user asks "near me" with no city, ask which city first; the bundled data is city-specific.

## Cities currently in the directory

Lugano · Lisbon · El Zonte · New York · Prague · Amsterdam.

If the user asks about another city, say it's not in the local snapshot yet and suggest checking [btcmap.org](https://btcmap.org) directly.
