# KaleidoMind Architecture

The design KaleidoMind builds to — how one AI brain drives a multi-L2 Bitcoin
wallet across a phone and a laptop, and how we measure which model is best.

## 1. Core principle: one contract, many transports

The model must see the **same tools** on every surface — only *how they execute*
changes. This makes skills portable and the model comparison honest.

```
                ┌──────────────  @kaleidorg/mind (the brain)  ──────────────┐
                │  Engine (agentic loop) · Skills · Confirmation gate        │
                │  injected: LLMProvider (QVAC) + ToolSources                 │
                │  ★ owns the canonical tool CONTRACT (names + schemas)       │
                └─────────────────────────────────────────────────────────────┘
                                       │ identical tool names + schemas
         ┌─────────────────────────────┼─────────────────────────────┐
     MOBILE (rate)                 DESKTOP (Tauri)               EVAL / CLI
     no CLI                        + CLI                         (benchmark)
  in-process funcs            one MCP, namespaced            stub handlers
  → WDK adapters              (spark_* rln_* arkade_*)       (canned, repro)
  (local default) ──P2P──▶    + `kaleido` CLI mirror
  delegate optional
  confirm → UI sheet          confirm → dialog               auto-approve
```

### Locked decisions
- **Desktop tools:** *one* MCP server (`kaleido-mcp`), tools **namespaced per
  layer** (`spark_*`, `rln_*`, `arkade_*`). A skill scopes to one layer so a
  small model never sees the whole list at once.
- **Contract home:** the canonical tool definitions live in **`@kaleidorg/mind`**
  (core). The MCP server, the mobile in-process source, and the CLI all import
  the same schemas — one source of truth.
- **Mobile execution:** **in-process by default** (WDK adapters, fully on-device
  + private); **P2P-delegate to a paired desktop's MCP optional** for heavy work.

## 2. Cross-surface transport matrix

| | Mobile (rate) | Desktop (Tauri) | Eval |
|---|---|---|---|
| Reasoning | QVAC on-device / delegated | QVAC local (sidecar) | QVAC |
| Tool execution | in-process → WDK adapters | `kaleido-mcp` (namespaced) **+ CLI** | stubs |
| Tool source | `InProcessToolSource` | `McpToolSource` (+ `createCliToolSource`) | stub source |
| Mechanisms tested | `fc`, `skill` | `fc`, `mcp`, `skill`, `cli` | all |
| Confirm-before-spend | UI sheet | dialog | auto-approve |

## 3. The canonical tool contract (per layer, namespaced)

Defined once in core as `ToolDef[]` with a `spend` flag → `requiresConfirmation`.
Same names everywhere; the binding differs by surface.

### Per-layer
| Layer | Tools |
|---|---|
| **Spark** | `spark_get_balance` · `spark_get_address` · `spark_create_invoice(amount_sats?)` · `spark_send(amount_sats,to)` 🔒 |
| **RLN / RGB** | `rln_get_balances` · `rln_get_node_info` · `rln_list_channels` · `rln_create_ln_invoice(amount_sats?)` · `rln_create_rgb_invoice(asset,amount)` · `rln_pay_invoice(invoice)` 🔒 · `rln_send_asset(asset,amount,to)` 🔒 |
| **Arkade** | `arkade_get_balance` · `arkade_get_address` · `arkade_send(amount_sats,to)` 🔒 |
| *(later)* **Liquid** | `liquid_get_balance` · `liquid_create_invoice(asset,amount?)` · `liquid_send(asset,amount,to)` 🔒 |

### Cross-cutting (router + helpers)
| Tool | Purpose |
|---|---|
| `get_balances(layer?)` | aggregate or per-layer balances |
| `resolve_contact(name)` | → `{ln_address, npub, preferred_layer}` |
| `get_price(asset?, fiat?)` | spot price (for fiat-denominated asks) |
| `fiat_to_sats(amount, currency)` | convert (small models can't do the math reliably) |
| `get_swap_quote(from,to,amount)` | quote a swap |
| `execute_swap(quote)` 🔒 | run it |
| `send_payment(asset, amount, to, layer?)` 🔒 | **unified router** — picks the rail for the asset, or uses `layer` if given |

🔒 = `spend: true` → confirmation-gated.

The unified `send_payment` is the high-level entry a skill prefers; the per-layer
`*_send` are the low-level primitives.

### KaleidoSwap maker — `kaleidoswap/contract.ts`

Same shape, separate contract — declared in `packages/core/src/kaleidoswap/contract.ts`,
bound by `bindKaleidoswapTools(handlers, { groups? })`. Grouped so a host can
expose only the read tools to an eval/sandbox.

| Group | Tools |
|---|---|
| **market** (read) | `kaleidoswap_get_assets` · `kaleidoswap_get_pairs` · `kaleidoswap_get_quote(from,to,amount,side?)` · `kaleidoswap_get_nodeinfo` |
| **orders** | `kaleidoswap_place_order(quote_id)` 🔒 · `kaleidoswap_get_order_status(order_id)` · `kaleidoswap_get_order_history` |
| **atomic** | `kaleidoswap_atomic_init(quote_id, receive_invoice)` 🔒 · `kaleidoswap_atomic_execute(atomic_id)` 🔒 · `kaleidoswap_atomic_status(atomic_id)` |

The atomic chain is driven deterministically by `kaleidoswapAtomicRecipe` —
quote → create RGB/LN receive invoice → init → pay → execute (single confirmation
for the whole multi-spend unit). Slot extraction can be forced through the model
(`forceModelExtract`) for better natural-language handling of user intents, with
deterministic fallbacks to protect precision, leg selection, and reliability.
Multi-spend recipes have every spend gated by the recipe runner (intermediate
steps too).

### LSPS1 channel orders — `lsps1/contract.ts`

LSP-agnostic (`lsp_*`, not `kaleidoswap_lsp_*`) so a different LSP can be swapped
in by changing only the host's binder. Bound by `bindLsps1Tools(handlers)`.

| Tool | Purpose |
|---|---|
| `lsp_get_info` | LSP capabilities: min/max channel size, fees |
| `lsp_get_network_info` | LSP node URI for pre-connect / display |
| `lsp_estimate_fees(lsp_balance_sat, …)` | Fee before committing |
| `lsp_create_order(lsp_balance_sat, …)` 🔒 | Place a channel order — returns a Lightning invoice to pay |
| `lsp_get_order(order_id)` | Poll until the channel opens |

## 4. Skills = "how to call the tools" + routing

Skills ship in core and load identically on both surfaces. They encode *when +
how* to use the tools and the **layer-routing rules** — exactly the "info on how
to call the MCPs". Most payment/swap/receive skills remain plan-deterministic
(recipe owns the ordered steps for reliability on tiny models), but we have
evolved hybrid use:
- **payments / receive / (simple) swap** — resolve contact → price → `fiat_to_sats` → (gate) → `send_payment` on the right rail (or equivalents).
- **atomic swap** (via `kaleidoswapAtomicRecipe`) — quote → (single gate) → init/whitelist/execute. Slot extraction can be model-driven (`forceModelExtract`) for better intent parsing, with deterministic fallbacks for precision.
- **receive** — `*_create_invoice` on the requested/best layer.
- **per-layer** (`spark`, `rln`, `arkade`) — the tool list + when to choose that rail (e.g. USDT → RLN/RGB unless Liquid specified; fast small BTC → Spark).
- **Discovery** (merchant-finder) — intentionally more model-leveraging for NL understanding of vague "near me / coffee in X" queries, context, result post-processing, and RAG hybrid (pluggable selectors).

## 5. Safety: confirm-before-spend (engine-enforced)

Not model-dependent. Tools flagged `spend` carry `requiresConfirmation: true`; the
**Engine pauses and calls the host's `onConfirm`** before executing.
- **Mobile** → a confirmation sheet (amount, destination, rail).
- **Desktop** → a dialog.
- **Eval** → auto-approve, and assert the gate fired (proof the mechanism works).

The model can never bypass a spend gate — it's structural.

## 6. How we choose "the best model"

The eval runs **per-surface configs** (mobile = `fc + skill`; desktop adds
`mcp + cli`) across models, reporting:
- **accuracy** — does it resolve the request (right tool + right args; right plan on multi-step)?
- **thinking time** — decision latency, model resident in RAM.
- **reliability** — consistency across K repeats.

→ a recommended model **per device class** (combined with `capabilityProfile`,
which gates by RAM). Tracks: **A single-step** (tool decision) and **B
multi-step** (agentic chains like "pay bob 3 EUR").

## 7. Roadmap

| Phase | Deliverable | Status |
|---|---|---|
| 1. Spec | this doc | ✅ |
| 2. Contract in core | per-layer `ToolDef[]` + spend flags, one source of truth | ▢ |
| 3a. Desktop binding | `kaleido-mcp` namespaced tools + `kaleido` CLI mirror | ▢ |
| 3b. Mobile binding | in-process handlers → Spark/RLN/Arkade WDK adapters | ▢ |
| 4. Skills | payments / receive / swap + per-layer routing | ▢ |
| 5. Safety | flag spend tools; wire `onConfirm` (mobile sheet, desktop dialog) | partial (engine gate exists) |
| 6. Eval | per-surface × model → "best model per device" table | A done · B planned |
| 7. Demo | rate + desktop use the contract end-to-end | ▢ |

## 8. What exists today vs. what changes
- **Have:** Engine + ToolSources (in-proc/MCP/CLI) + Skills + confirmation gate; a monolithic ~64-tool `kaleido-mcp`; mobile in-proc tools (`aiAssistantFunctions`, 8); eval harness.
- **Change:** namespace the mega-MCP per layer; refactor mobile tools to the canonical contract (multi-L2 via WDK); flag spend tools.
- **Add:** the contract module (§3) in core; the missing cross-cutting fns; the routing skills; per-surface eval configs.
