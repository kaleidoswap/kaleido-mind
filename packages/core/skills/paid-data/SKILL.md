---
name: paid-data
description: "Fetch data behind an HTTP 402 Lightning paywall (L402 or MPP): paid feeds, pay-per-call APIs, unlockable resources, and finding paid APIs in the 402index registry."
tools: fetch_paid_resource, search_paid_apis, mpp_request_challenge, mpp_parse_challenge_header, rln_mpp_pay, spark_mpp_pay, mpp_submit_credential, l402_request_challenge, l402_fetch_resource
triggers: premium, paid, l402, mpp, 402, paywall, pay per call, paid api, gated, unlock
metadata:
  author: kaleidoswap
  version: "0.3.0"
---
# Paid data

A server answers 402 with a Lightning invoice; you pay it and present the proof.
Use whichever tools are available.

## Do
- In-app: `fetch_paid_resource` with the `url` pays small invoices (capped by the host)
  and returns the data. A declined payment is the answer; don't retry.
- kaleido-mcp, three steps before `expires_at` (~60 s):
  1. `mpp_request_challenge` (`url`) → `challenge_id`, `invoice`, `amount_sats`.
  2. `rln_mpp_pay` (`invoice`, `challenge_id`) (or `spark_mpp_pay`, same args) →
     `credential`.
  3. `mpp_submit_credential` (`url`, `credential`) with the credential unchanged.
- Show `amount_sats` before paying; ask for a yes above 1,000 sats. Pay only
  for URLs the user asked for. Stop after two failures.
- Find APIs: `search_paid_apis` (`query`, `health: "healthy"`), then run the flow on
  the chosen `url`.

## Examples
- "Get the premium feed at https://api.example.com/feed" → `mpp_request_challenge {"url":"https://api.example.com/feed"}`
- "Pay that challenge" → `rln_mpp_pay {"invoice":"<invoice>","challenge_id":"<challenge_id>"}`
- "Any paid weather APIs?" → `search_paid_apis {"query":"weather","health":"healthy"}`
- In-app → `fetch_paid_resource {"url":"https://api.example.com/feed"}`
