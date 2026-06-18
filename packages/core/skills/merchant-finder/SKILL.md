---
name: merchant-finder
description: "Find Bitcoin-accepting merchants near the user using live BTC Map data and the device's real location. Triggers when the user asks where to spend Bitcoin, buy pizza/food with sats or bitcoin, eat at restaurants/cafes paying with sats, for a shop, store, restaurant, cafe, bar, or ATM that accepts Bitcoin, or for merchants nearby or in a city like turin."
tools: find_merchant_locations
triggers: merchant, merchants, shop, shops, store, stores, restaurant, restaurants, cafe, cafes, bar, bars, atm, atms, accept, accepts, accepting, nearby, near me, around me, where can i spend, pizza, pizz, food, coffee, eat, dinner, lunch, bitcoin map, btcmap
metadata:
  author: kaleidoswap
  version: "0.3.0"
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
   result returned by the merchant search tool in the CURRENT turn. Use the
   merchant search tool for every place question, even if a similar one
   was answered earlier — do NOT reuse a previous answer. Never invent a
   merchant. Do not mention the exact name of the tool in your text reply
   to the user.
2. **List, don't pick.** A "where can I…" / "find merchants" question is a
   LIST question. Show every merchant the tool returned (cap at the first ~5
   if there are many), ONE LINE EACH. Never collapse a list of 10 to one
   example. The host's "keep replies short" guidance applies to prose, not to
   a list the user explicitly asked for.
3. **Prefer minimal arguments; use understanding when mapping.** When the user
   speaks naturally, map their words to the available fields intelligently but
   conservatively. When in doubt, pass FEWER fields rather than guessing. The
   tool and the live data (plus any RAG hits you also fetch) are the source of
   truth — your job is to get the right starting call and then reason over
   what comes back.

## Using your understanding (the model is meant to help here)

- Translate vague or natural language into the best minimal call:
  - "coffee near the station", "grab a bite", "something to eat" → `query: "coffee"` or `"food"` / `"pizza"` (or leave descriptive terms in `query`); consider `category: "cafe"` or `"restaurant"` only when it clearly fits one of the allowed values.
  - "near me for lunch" or "around here" → start with empty or just a broad `query`; let the device location do the work. You may infer a reasonable city from prior turns ("you mentioned Lugano earlier") and pass `near_address`.
  - "ATMs or shops that take lightning" → `query: "atm"` or separate calls, or put "atm shop lightning" in `query`.
  - "the cheaper ones", "with websites", "open late", "good for dinner" → use the tool first (possibly broad), then in the same or follow-up turn use the returned list + any other context/memory to filter, rank or describe. Do not fabricate entries.
  - **Critical for currency terms**: "where can I spend sats in turin", "bitcoin merchants in X", "places that accept crypto" are generic spend requests. **Do not** put "sats", "btc", "bitcoin", "spend" into `query` or invent a `category` (e.g. "shop"). Use only `near_address` (or empty). Putting currency words in query almost always returns zero results because the data source already only contains Bitcoin-accepting places.

- Multi-turn and post-processing: After the merchant search tool returns a list you may (and should) reason over it: rank by distance or relevance to the user's phrasing, surface `phone`/`website`/`opening_hours` when present, note accepts_lightning, suggest next actions ("want directions or to check one?"), or combine with `search_knowledge` / memory results if merchants have been ingested for the area.

- Hybrid live + RAG: If a `search_knowledge` tool is available and a merchant corpus is loaded, you can use both the live finder (for freshness + distance) and search for background on an area or previously-seen places. Present live results as the actionable list.

- Context is fair game for *formulating the call or summarizing results* (e.g. previous city mentioned, user's preference for Lightning). It is never a substitute for calling the tool for the actual current list of places.

## How to call the tool

1. **Start with the merchant search tool.** Map the user's words to fields using the guidance above. The schema accepts:

   - `query` — free-text the user effectively named or implied (e.g. "coffee", "pizza", "food", "tapas", "atm"). Good place for terms that don't match a strict category. **Omit entirely** for generic "spend sats", "where can I spend", "merchants", "places to spend bitcoin", or "accept crypto". **Never** put "sats", "sat", "bitcoin", "btc", "crypto", "spend", or similar currency/verb terms here — the data source is already Bitcoin-only and this will usually return zero results.

   - `category` — **exactly one** of the allowed values when it fits cleanly: `restaurant`, `cafe`, `bar`, `shop`, `grocery`, `lodging`, `atm`. Leave empty otherwise. **For any generic "spend sats / where can I spend bitcoin / merchants in X" request, leave category empty.** Do not guess a category just because the user wants to spend. Generic nouns like "merchant", "place", "store" belong in `query` (or omitted), never as the category.

   - `near_address` — city / neighborhood / address when the user named a place instead of (or in addition to) "near me". The host will geocode it.

   - `radius_km` — only when the user gave a specific distance ("within 2 km"). Default (5 km) is already reasonable for a city; the backend applies a sensible bound.

   - `limit` — only when the user named a count (1–20).

   Positive examples (using understanding):
   - "where can I spend btc near me" → use the tool with `{}`
   - "where can I spend sats in turin" → use the tool with `{ near_address: "Turin" }`   ← generic spend → minimal args, no query, no category
   - "where can I spend btc in Lugano" → use the tool with `{ near_address: "Lugano" }`
   - "cafes in Lisbon" → use the tool with `{ category: "cafe", near_address: "Lisbon" }`
   - "pizza places in Switzerland that take bitcoin" → use the tool with `{ query: "pizza", near_address: "Switzerland" }`
   - "lightning bars in NYC, within 2 km" → use the tool with `{ category: "bar", near_address: "New York", radius_km: 2 }`
   - "coffee near the station" or "grab a bite around here" → use the tool with `{ query: "coffee" }` or `{ query: "food" }` (let location come from device or prior context)
   - "ATMs or shops that take sats in the center" → first use the tool with `query: "atm shop"` + appropriate near_address; then reason over results.

   Things that are still wrong (schema or data reasons):
   - `category: "merchant"` or `"place"` (invalid per schema).
   - `query: "sats"`, `"btc"`, `"bitcoin"`, or any currency/spend verb (the dataset is already Bitcoin-only; these filters return nothing or almost nothing useful. "Spend sats" is a generic merchant request, not a filter term).
   - Guessing a tiny `radius_km` the user never mentioned (results will be empty).
   - Inventing a `category` (like "shop") for a completely generic "where can I spend sats" query — use no category and let the data speak.
   - Adding constraints the user did not name when a minimal call would have returned more relevant places.

   **Real bad example that causes zero results**:
   - "where can I spend sats in turin" → bad: use query "sats" + category "shop"
     ( "sats" in query + guessed category over-filters everything; correct is just the near_address or nothing).

2. **Present the results.** Each row carries:
   - `name`, `category`, `address`
   - `distance_m` when present — show in metres or km
   - `accepts_bitcoin` / `accepts_lightning` — relevant because Lightning is
     fastest for small payments
   - `phone`, `website`, `opening_hours` when present — surface if asked or relevant

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

- **List, don't fabricate.** Show the merchants the tool actually returned (first ~5–8 is fine for long lists), one line each. You may add a short prose lead or helpful follow-up ("These are sorted by distance. The first two have websites.") but the names, categories, addresses and distances must come from the tool result in this turn.
- One line per merchant (example):
  `Name — category, address (X m away, accepts: lightning, onchain)`.
- If zero merchants: say so plainly. Suggest widening radius or trying a `near_address`. Do not invent alternatives.
- When `precise_location` is false for a "near me" result, mention the fallback area that was used.
- After showing the list you are free to reason, rank, or ask a clarifying follow-up using the data + conversation context.

**Remember**: the live merchant search tool (plus any RAG merchant documents you also search) are the only sources of place information. Your value is excellent intent → arg mapping on the way in, and helpful reasoning / presentation on the way out. Do not name the tool in your user-facing reply.
