---
name: rgb-lightning-node
description: "Drive the user's local RGB Lightning Node (RLN) — read its pubkey/status, list channels and their capacities, check RGB asset balances, manage channels/peers, whitelist a swap, or create Lightning/RGB receive invoices. Triggers when the user asks about the node, their channels or capacities, needs an invoice, wants to issue/mint a new RGB token or NFT, or is mid-atomic-swap and the maker needs the node pubkey or a swapstring whitelisted."
tools: rln_get_node_info, rln_get_balances, rln_list_channels, rln_list_assets, rln_get_asset_balance, rln_refresh_transfers, rln_get_address, rln_send_btc, rln_send_asset, rln_pay_invoice, rln_open_channel, rln_close_channel, rln_connect_peer, rln_get_channel_id, rln_atomic_taker, rln_list_swaps, rln_get_swap, rln_list_payments, rln_create_ln_invoice, rln_create_rgb_invoice, rln_list_transfers, rln_create_utxos, rln_issue_asset
triggers: node, nodeinfo, pubkey, peer, channels, channel capacity, list channels, open channel, close channel, inbound, capacity, asset balance, whitelist, taker, swapstring, swaps, payments, invoice, receive, send asset, send rgb, on-chain address, deposit, rgb invoice, ln invoice, issue, mint, new token, nft, utxos, transfers
metadata:
  author: kaleidoswap
  version: "0.3.0"
---

# RGB Lightning Node (taker-side)

You drive the **user's own** RGB Lightning Node running locally. In a KaleidoSwap
atomic swap the **maker** owns init / execute / status (those are
`kaleidoswap_atomic_*` tools, separate REST endpoints). The node's job in a
swap is narrow: **expose its pubkey and whitelist the maker's swapstring**.
The node does NOT init or execute swaps.

## Critical rules

You have **no knowledge** of the node's pubkey, channel state, balance, or any
invoice contents. Every value in your reply MUST come from a tool result
returned in the CURRENT turn — never invent a pubkey, channel id, invoice
string, or sats balance. Never reuse a value from a previous turn.

**Calling the tool IS the answer.** If the user asks "what's my pubkey?", call
`rln_get_node_info` — do not describe how to fetch it.

## When to use each tool

### `rln_get_node_info` — no args
Returns:
- `pubkey` — the node's identity (32-byte hex).
- `num_channels` — total channels (may include unusable ones).
- `num_usable_channels` — subset that can route a payment right now.
- `local_balance_sat` — **sats YOU own** across all channels. This is your
  **spend** capacity (outbound). It is **NOT** receive capacity, **NOT**
  inbound liquidity, and **NOT** total channel capacity.
- `pending_outbound_payments_sat` — in-flight, temporarily locked.
- `num_peers` — currently connected peers.

Call this when:
- The user asks about the node, pubkey, peers, channel count, or how much
  they can **spend**.
- An atomic swap is in progress and the maker needs `taker_pubkey` —
  fetch the pubkey from this tool's `pubkey` field and pass it to
  `kaleidoswap_atomic_execute`.

**Do NOT** use this tool's `local_balance_sat` to answer a question about
**inbound liquidity / receive capacity** — that is a different quantity (the
peer's side of each channel). For per-channel inbound/outbound and total
capacity, use `rln_list_channels` (below), NOT this tool.

### `rln_list_channels` — no args
Returns `{ channels: [...], count }`. Each channel carries:
- `channel_id`, `peer_alias`, `status`, `ready`, `is_usable`
- `capacity_sat` — total channel size.
- `outbound_sat` — what YOU can send (your local balance).
- `inbound_sat` — what you can RECEIVE on this channel (the peer's side).
- `asset_id`, `asset_local_amount`, `asset_remote_amount` — for RGB asset
  channels: the asset and how much is on each side.

Call this when the user asks to **list channels**, asks about **per-channel
capacity**, **inbound/receive capacity**, or wants to **verify a channel they
just bought** opened with the requested size. Report each channel as one line:
`capacity_sat total — outbound_sat / inbound_sat (asset if present), status`.

When verifying a freshly-bought channel: a channel order opens
ASYNCHRONOUSLY (seconds to minutes after payment). If the new channel isn't
listed yet, say it's still opening and suggest checking again — don't claim
failure.

### `rln_list_assets` — no args
Lists RGB assets known to the node with per-asset balances (settled, future,
spendable, offchain_outbound, offchain_inbound). Use for "what assets do I
hold / what's my USDT balance".

### `rln_get_asset_balance` — { asset_id }
Balance for one RGB asset by id. Use after `rln_list_assets` gave you the id,
or when the user names a specific asset.

### `rln_refresh_transfers` — no args
Syncs pending RGB transfers. Call it before re-reading a balance or transfer
status that looks stale (e.g. right after an invoice was paid or a swap filled).

### `rln_get_address` — no args
An on-chain BTC address of the node, for funding it. Not an RGB invoice and not
a Lightning invoice.

### `rln_send_btc` — { address, amount_sat, fee_rate? } — 🔒 confirm-gated
Sends on-chain BTC from the node. Only when the user gave both the address and
the amount.

### `rln_send_asset` — 🔒 confirm-gated
Sends an RGB asset to the recipient encoded in an RGB invoice. Use the argument
names of the schema you were given: in-app wallets take `{ asset, amount, to }`
(ticker or asset_id, units, the invoice); kaleido-mcp takes
`{ asset_id, amount, recipient_id }`. Never invent a recipient.

### `rln_pay_invoice` — { invoice } — 🔒 confirm-gated
Pays a BOLT11 Lightning invoice from the node. Pass the full invoice string.

### Channels and peers
- `rln_connect_peer { peer_pubkey_and_addr }` — `pubkey@host:port`. Needed
  before opening a channel to a peer the node has never seen.
- `rln_open_channel { peer_pubkey_and_addr, capacity_sat, asset_id?, asset_amount?, push_msat?, is_public? }`
  — 🔒 confirm-gated. Locks on-chain BTC (and optionally an RGB asset) into a
  channel. Opening is asynchronous: report the `temporary_channel_id` and
  suggest checking `rln_list_channels`.
- `rln_get_channel_id { temporary_channel_id }` — the final `channel_id` once
  the channel is established.
- `rln_close_channel { channel_id, peer_pubkey, force? }` — 🔒 confirm-gated.
  Both values come from `rln_list_channels`. `force` only for an unresponsive
  peer.

### `rln_list_payments` — { limit? }
Recent Lightning payments, sent and received. Use for "did I get paid" /
"what did I pay" over Lightning.

### `rln_list_swaps` / `rln_get_swap { payment_hash, taker? }`
Atomic swaps as the node sees them (HTLC status). For the maker-side status use
`kaleidoswap_atomic_status`.

### `rln_atomic_taker` — { swapstring } — 🔒 confirm-gated
Tell the node "I accept this swap." Args: the `swapstring` returned by
`kaleidoswap_atomic_init`. The node validates and stores it; **no funds move
here**, but the user is committing to the swap so the engine pauses for
confirmation.

Call this **after** `kaleidoswap_atomic_init` and **before**
`kaleidoswap_atomic_execute`. Never call with an empty or invented swapstring
— the node will reject it.

### `rln_create_ln_invoice` — Lightning invoice for receiving sats
Args:
- `amount_sats` (optional) — omit for an amountless invoice.
- `expiry_sec` (default 3600, kaleido-mcp only) — invoice TTL in seconds.

Use when the user wants to **receive** a Lightning payment. Do NOT call inside
an atomic swap flow unless the user explicitly asked to invoice someone.

### `rln_create_rgb_invoice` — on-chain RGB receive invoice
Args (use the names in your schema):
- in-app wallets: `asset` (ticker or asset_id) + `amount`.
- kaleido-mcp: `asset_id` (omit for an any-asset invoice), `amount` (display
  units), `duration_seconds` (default 86400).

Reply with the full `invoice` string; the payer needs all of it.

Use when the user wants to **receive** an RGB asset directly (not over
Lightning). Outside the atomic swap flow.

### `rln_list_transfers` — { asset }
Transfers for one asset (issuance, sends, receives) with `status`
(`WaitingCounterparty`, `WaitingConfirmations`, `Settled`, `Failed`). Use it to
answer "has my RGB invoice been paid?".

### `rln_create_utxos` — { num? } — 🔒 confirm-gated
Creates colorable UTXOs (spends a little on-chain BTC). A fresh node needs
these before it can **issue** or **receive** RGB assets. Call it when an RGB
call fails with "no available UTXOs", then retry the original action.

### `rln_issue_asset` — { name, ticker, amount, precision?, schema? } — 🔒 confirm-gated
Creates a **new** RGB asset owned by this node. `schema`: `NIA` fungible token
(default), `CFA` collectible, `UDA` unique asset / NFT (supply 1). `amount` is
whole units. Reply with the returned `asset_id` — the user needs it to invoice
or send the new asset.

Examples:
- "issue 1000 TICKET tokens called Hackathon Ticket" →
  `rln_issue_asset { name: "Hackathon Ticket", ticker: "TICKET", amount: 1000 }`
- "mint an NFT called Genesis Badge" →
  `rln_issue_asset { name: "Genesis Badge", ticker: "GENESISB", amount: 1, schema: "UDA" }`
- "has anyone paid my TICKET invoice?" → `rln_refresh_transfers` →
  `rln_list_transfers { asset: "TICKET" }`

`rln_list_transfers`, `rln_create_utxos` and `rln_issue_asset` are provided by
in-app wallets and the CLI; kaleido-mcp does not expose them yet. If a tool is
not in your list, say so instead of guessing.

## The maker / node split

A user-driven swap on KaleidoSwap is a two-service flow. Keep them straight:

| Step | Owner | Tool |
|------|-------|------|
| Quote | maker | `kaleidoswap_get_quote` |
| Init  | maker | `kaleidoswap_atomic_init` (returns swapstring + payment_hash) |
| Pubkey | **node** | `rln_get_node_info` (read `pubkey`) |
| Whitelist | **node** | `rln_atomic_taker` (pass the swapstring) |
| Execute | maker | `kaleidoswap_atomic_execute` (needs swapstring + taker_pubkey + payment_hash) |
| Status | maker | `kaleidoswap_atomic_status` (pass atomic_id or payment_hash from the atomic recipe summary or prior init result; see "remember" line in history) |

The node's two contributions to the swap are the **pubkey** and the
**whitelist ack** — nothing more. Don't reach for `/makerinit` or
`/makerexecute`; those are for nodes that act AS the maker, which is not us.

## Reply style

- One short sentence built from the tool result.
- Pubkeys are long hex strings — quote them in monospace if you can, never
  truncate them when the user explicitly asked for them.
- For `rln_get_node_info`, if the user just said "what's my node status?",
  surface pubkey + num_usable_channels + local_balance_sat. Don't dump the
  whole `details` object.
