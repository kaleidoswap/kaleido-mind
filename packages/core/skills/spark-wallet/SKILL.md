---
name: spark-wallet
description: "Operate the user's Spark BTC wallet on this device — check Spark balance, get a Spark deposit address, create a Spark Lightning invoice to receive, pay any BOLT11 Lightning invoice with Spark, or send BTC on-chain from Spark. Use this when the user names Spark explicitly OR when paying a Lightning invoice on a phone where Spark is the connected layer. Pairs with the bitrefill skill: a Bitrefill purchase that returns a Lightning invoice is paid with `spark_pay_invoice`."
tools: spark_get_balance, spark_get_address, spark_get_onchain_address, spark_create_invoice, spark_pay_invoice, spark_send, get_price, fiat_to_sats, bitrefill_search, bitrefill_get_product, bitrefill_get_balance, bitrefill_create_invoice, bitrefill_get_invoice, bitrefill_get_order
triggers: spark, sprak, spakr, spark wallet, pay with spark, send with spark, spark balance, spark address, spark invoice, lightning invoice, pay invoice, bolt11, ln invoice, pay this invoice, on-chain address, onchain address, deposit address, deposit btc, fund spark
metadata:
  author: kaleidoswap
  version: "1.0.0"
  layer: spark
---

# Spark wallet

Spark is one of the user's connected BTC layers (alongside RLN/RGB and Arkade
on some hosts). It speaks Lightning natively — receive via `spark_create_invoice`,
send via `spark_pay_invoice` (BOLT11) or `spark_send` (on-chain). All numbers
are in **satoshis** unless stated otherwise.

## Three "addresses", three different tools (read this carefully)

The word "address" can mean three completely different things on Spark.
Each has a DIFFERENT tool, a DIFFERENT shape, and a DIFFERENT use. If you
return the wrong one, the user loses money on a bad deposit. Pick by what
the user is trying to DO, not just by the word "address":

| User intent | Tool | What you get | Looks like |
|---|---|---|---|
| Receive a **Spark-to-Spark** transfer (off-chain, within Spark) | `spark_get_address` | Spark identity / pubkey | `sparkrt1…` / `spark1…` |
| Deposit **L1 Bitcoin** into Spark from the on-chain world | `spark_get_onchain_address` | Real Bitcoin on-chain address | `bc1…` / `tb1…` / `bcrt1…` |
| Receive over **Lightning** (BOLT11) | `spark_create_invoice` | A Lightning invoice string | `lnbc…` / `lntb…` / `lnbcrt…` |

**Disambiguation by phrasing — examples:**

- "give me my **on-chain address**" / "**bitcoin address** to fund Spark"
  / "**deposit address**" / "where do I send BTC from my hardware wallet
  / mainnet" → `spark_get_onchain_address`. Result starts with bc1/tb1/
  bcrt1 — verify before replying.
- "my **Spark address**" / "give me a **Spark address**" / "where do I
  receive a **Spark transfer**" → `spark_get_address`. Result starts with
  spark1/sparkrt1. **DO NOT label this as an on-chain address — it is
  off-chain.**
- "give me an **invoice for N sats**" / "an **LN invoice**" / "**pay me**
  N sats" → `spark_create_invoice({amount_sats: N})`. Result is a `lnbc…`
  string.

**Critical: when the user says "on-chain", they mean L1 Bitcoin.** Never
return a `sparkrt1…` and call it "on-chain". If you return a
`spark_get_address` result, you MUST describe it as a Spark (off-chain)
address — never as an on-chain or Bitcoin address. If you return a
`spark_get_onchain_address` result, you can call it an on-chain Bitcoin
deposit address.

A useful sanity check before you send the reply: glance at the
`address` string's prefix. If it begins with `spark`, it's the off-chain
Spark identity. If it begins with `bc1`/`tb1`/`bcrt1`, it's an on-chain
BTC address. If it begins with `lnbc`/`lntb`/`lnbcrt`, it's a Lightning
invoice. Whatever you call it in your reply MUST match its actual prefix.

## What Spark holds (and what it does NOT)

This is the single most important thing to get right when the user asks
about "assets on Spark" or "what can I trade on Spark".

**Spark holds:**
- **BTC** (sats) — Spark's native on-chain-pegged BTC.
- **Spark-native tokens** — e.g. **USDB**. These are tokens issued on the
  Spark protocol itself, traded on **Flashnet** (Spark-native AMM).

**Spark does NOT hold:**
- **RGB assets** (USDT, XAUT, …). RGB assets are a DIFFERENT protocol on
  Bitcoin/Lightning — they live on the user's **RLN** (RGB Lightning Node),
  NOT Spark. A USDT balance, if the user has one, is on RLN — never on
  Spark.
- Tokens from any other chain (Ethereum USDT, Tron USDT, Solana, …). The
  wallet does not custody those at all.

**Asset → which skill / venue:**

| Asset | Layer | Swap venue | Skill |
|---|---|---|---|
| BTC / sats | Spark / RLN / on-chain | Either (depends on direction) | spark-wallet (Spark side), wallet-assistant |
| USDB (and other Spark tokens) | Spark | **Flashnet** (AMM) | **flashnet-swaps** |
| USDT, XAUT (RGB assets) | RLN/RGB | **KaleidoSwap maker** | **kaleido-trading** |

If the user asks "what can I trade on Spark?", the correct answer lists
Spark-native tokens (BTC + USDB and anything else
`flashnet_list_pools` shows). **Never** answer USDT/XAUT for Spark.
Conversely, if asked "what can I trade on KaleidoSwap?", that's RGB
assets (USDT, XAUT) — **not** USDB.

When in doubt about what's actually tradeable, the source of truth is the
TOOL, not your training data — call `flashnet_list_pools` (Spark side) or
`kaleidoswap_get_assets` (RGB side) and report what comes back.

## Critical rules (read first)

1. **Always re-fetch volatile state — every turn, every time.** Balance,
   address, invoice status, and any number that can change MUST come from a
   tool call THIS turn. Do NOT reuse a value from a previous turn, even if
   the user asked the exact same question 30 seconds ago. The user wouldn't
   ask twice if they didn't want a fresh check.

   - "what's my balance?" → ALWAYS call `spark_get_balance`. Yes, even if
     you just called it. The whole point of asking again is to get a new
     reading.
   - "give me my address" → ALWAYS call `spark_get_address`. Spark may
     rotate or surface a fresh address.
   - "did my invoice settle?" → ALWAYS re-fetch the invoice/order status.

   The ONLY thing you can reuse from history is the user's own input
   (e.g. "the invoice I just made" → look up its id in history and call
   the status tool on it).

2. **Never invent a balance, invoice or address.** Every BTC number, BOLT11
   string, and address in your reply MUST come from a Spark tool result
   returned in the CURRENT turn — never guessed, never quoted from memory.

3. **Read the tool result exactly.** `spark_get_balance` returns
   `{ total, layer, network, connected }`. `connected: true` means the
   Spark wallet IS active and reachable; `total: 0` with `connected: true`
   simply means the user has no sats yet (perfectly normal for a fresh
   wallet on regtest). Do NOT say "your wallet isn't connected" unless
   `connected: false` or the tool threw an error. Say "your Spark wallet
   is connected but empty — fund it with `spark_get_address`" when
   `total: 0, connected: true`.

4. **Choose the right send tool by destination shape.**
   - Starts with `lnbc…` / `lntb…` / `lnbcrt…` → BOLT11 Lightning invoice → use
     **`spark_pay_invoice`**.
   - Starts with `bc1…` / `tb1…` / `bcrt1…` → on-chain Bitcoin address → use
     **`spark_send`**.
   - Looks like `name@domain` (a Lightning address) → not a Spark target;
     either ask the host to resolve it first or use the cross-cutting
     `send_payment` router. Spark itself doesn't dereference LNURL.

5. **BOLT11 invoices encode their amount.** Don't pass `amount_sats` to
   `spark_pay_invoice` unless the invoice is amount-less. Re-stating the
   amount can produce silently-wrong sends on amount-less invoices.

6. **Confirm before spending.** `spark_pay_invoice` and `spark_send` are
   confirmation-gated by the contract — the host fires the gate
   automatically. Before the call, summarize in one line:
   `Paying 12,540 sats to lnbc12540n… from Spark. Confirm?`

7. **Spark genuinely unavailable = stop, don't guess.** If the tool
   THROWS with "Your SPARK wallet isn't connected yet" (an actual error,
   not a 0 balance), say so plainly and stop — don't substitute RLN or
   Arkade silently. The user may genuinely want Spark.

8. **Never refuse an action a listed tool performs.** If a tool in your
   set does what the user asked, CALL IT — do not reason about whether
   "get" means "create", whether the wording is an exact match, or
   whether some other tool would be "more correct". The user asking to
   "create an address" when you have `spark_get_address` means: call
   `spark_get_address`. Refusing to use an available tool is always wrong.

## How to call the tools

### Reads

- **`spark_get_balance({})`** — current spendable BTC in Spark (sats).
- **`spark_get_address({})`** — the user's **Spark identity**
  (`sparkrt1…`/`spark1…`), an OFF-CHAIN Spark-to-Spark receive target.
  Reusable — getting and creating are the same operation, so the right
  response to "create a Spark address" is ALSO this tool. NEVER call its
  result an on-chain address or a Bitcoin address; it is neither. NEVER
  reply "I cannot create an address" — this tool IS how you create one.
- **`spark_get_onchain_address({})`** — a real Bitcoin **on-chain
  deposit** address (`bc1…`/`tb1…`/`bcrt1…`) for funding Spark from L1.
  Use whenever the user says "on-chain", "bitcoin address", "deposit
  address", "fund Spark", or otherwise indicates they want to send L1
  BTC. NEVER substitute `spark_get_address` here.

### Receive

- **`spark_create_invoice({ amount_sats? })`** — Spark Lightning invoice.
  - Omit `amount_sats` for an "any amount" invoice.
  - Returns `{ invoice: "lnbc…", … }`.
  - This is the tool for "give me an invoice for N sats", NOT for any
    "address" ask.

### Send — pick by destination

- **`spark_pay_invoice({ invoice, amount_sats? })`** — pay a BOLT11 invoice.
  - The model's default Lightning spend tool. Use this for invoices from
    Bitrefill, a contact's invoice paste, or any `ln…` string.
  - Pass `amount_sats` ONLY when the invoice is amount-less (a 0-amount
    invoice). For ordinary amount-bound invoices, OMIT it.
- **`spark_send({ amount_sats, to })`** — on-chain Bitcoin send.
  - Use only when `to` is an on-chain address (`bc1…`). Never pass a BOLT11
    invoice here.

### Helpers

- **`get_price({ fiat? })`** / **`fiat_to_sats({ amount, currency })`** —
  for "how many sats is €10" style sub-questions before a Spark spend.

## Cross-skill flow with Bitrefill

When the user wants to buy something from Bitrefill and pay with Spark, the
typical chain is:

1. Call `bitrefill_search` / `bitrefill_get_product` to confirm the product +
   the right `package_id` (see the `bitrefill` skill).
2. Call `bitrefill_create_invoice({ products, payment_method: "lightning",
   refund_address: <a Spark or on-chain address> })` — Bitrefill returns a
   BOLT11 invoice on the response under `payment.lightning_invoice` (or
   similar — relay whatever the host surfaces).
3. **Pay with Spark**: `spark_pay_invoice({ invoice: <that BOLT11> })`. One
   confirmation gate; Spark settles the invoice in seconds.
4. Poll `bitrefill_get_invoice` until `status:"complete"`, then
   `bitrefill_get_order` for the redemption code.

If the user pre-funded a Bitrefill account, prefer
`payment_method:"balance"` instead — no Spark spend, instant settlement. Use
the Lightning path when the user explicitly says "pay with Spark/Lightning"
or has no Bitrefill balance.

## Reply style

- One short sentence per fact ("Spark holds 124,500 sats.").
- For invoices: show the invoice on its own line so the user can copy it.
- For sends: one-line pre-spend summary (amount + destination + "from
  Spark"), then the result.
- When `spark_get_balance` says zero and the user asked to spend, stop and
  say so — don't try to source funds from another layer silently.
