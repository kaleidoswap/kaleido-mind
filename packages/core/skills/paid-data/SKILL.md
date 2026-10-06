---
name: paid-data
description: Fetch premium or paywalled data behind an HTTP 402 Lightning payment (L402 or MPP, the Machine Payments Protocol) — paid feeds, pay-per-call APIs, unlockable resources — without signing up or holding an API key. Also finds paid APIs in the public 402index registry. Triggers when the user wants premium, paid, gated or unlockable data, or asks for a paid API.
tools: fetch_paid_resource, search_paid_apis, mpp_request_challenge, mpp_parse_challenge_header, mpp_submit_credential, rln_mpp_pay, spark_mpp_pay, l402_request_challenge, l402_fetch_resource
triggers: premium, paid, l402, mpp, 402, feed, subscription, unlock, paywall, pay per call, paid api, gated
metadata:
  author: kaleidoswap
  version: "0.2.0"
---

# Paid data

Servers gate a resource behind an HTTP 402 Lightning challenge; you pay the
invoice and present the proof. L402 is the Lightning-only subset of MPP. Tell
the user what was paid and what came back.

Use whichever tools you have:

## In-app: one call

`fetch_paid_resource({ url })` fetches, pays small invoices automatically
(capped by the host) and returns the data. Anything above the cap is declined;
report that instead of retrying.

## Over kaleido-mcp: three steps

```
1. mpp_request_challenge({ url })
   → { challenge_id, invoice, amount_sats, intent, expires_at, macaroon? }

2. rln_mpp_pay({ invoice, challenge_id, macaroon? })     ← pays from the RGB Lightning Node
   (or spark_mpp_pay with the same arguments, from the Spark wallet; better for
    tiny amounts where Lightning routing may fail)
   → { paid, payment_hash, preimage?, credential: "<JSON string>" }

3. mpp_submit_credential({ url, credential })            ← pass credential verbatim
   → { ok, status, data, receipt }
```

Finish all three before `expires_at` (~60 s); a credential is single-use, so
restart from step 1 if it expires. Keep the `receipt` as proof of payment.

- **Discovery:** `search_paid_apis({ query, protocol?, health: "healthy" })`
  lists registered endpoints with their price; pick a healthy one, then run the
  flow on its `url`.
- **Own fetch:** with a `WWW-Authenticate` header already in hand, use
  `mpp_parse_challenge_header({ url, www_authenticate })` instead of step 1.
- **Legacy L402-only servers:** `l402_request_challenge` /
  `l402_fetch_resource`. Prefer the `mpp_*` tools; they handle both.
- **Sessions:** `intent: "session"` challenges allow pay-once, then cheap
  repeat calls. Not every server offers them; fall back to `charge`.

| Error | Meaning | Fix |
|---|---|---|
| `Expected HTTP 402` | URL is not payment-gated | Fetch it normally |
| `payment failed` | Route or balance problem | Check balances; try `spark_mpp_pay` |
| `401 after submit` | Bad or reused credential | Redo steps 1–3 |
| `challenge expired` | Too slow between steps | Restart from step 1 |

## Rules

1. Show `amount_sats` before paying; ask for a yes above 1,000 sats.
2. Only pay challenges for URLs the user asked for.
3. Stop after two failures in a row and report; don't loop.
4. Dry run: report the price and what you would fetch; never pay.
