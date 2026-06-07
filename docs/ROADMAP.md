# KaleidoMind — Master Plan

Consolidated execution plan: architecture, the mobile-optimized agent (incl.
multi-step on a phone), skills, safety, the eval, and the phased roadmap.
Design rationale lives in [ARCHITECTURE.md](./ARCHITECTURE.md); methodology
findings in [BENCHMARK.md](./BENCHMARK.md) and [MEMORY_RAG.md](./MEMORY_RAG.md).

## 0. Goal

A private, on-device AI that drives a **multi-L2 Bitcoin wallet** (Spark · RLN/RGB
· Arkade · Liquid) across **mobile and desktop**, resolving real requests —
*"what's my balance", "invoice 25 USDT on Liquid", "pay bob 3 EUR", "buy 0.001
BTC with USDT"* — with **great UX on limited mobile hardware** and a hard
**confirm-before-spend** gate. We measure which QVAC model is best **per device**
(accuracy + thinking-time + reliability).

---

## 1. Architecture (locked — see ARCHITECTURE.md)

- **One tool contract, many transports.** Identical tool names/schemas everywhere.
- **Contract lives in `@kaleidorg/mind`** (core, single source of truth).
- **Desktop:** one `kaleido-mcp`, tools **namespaced per layer** (`spark_*`,
  `rln_*`, `arkade_*`) + a `kaleido` CLI mirror.
- **Mobile:** in-process tools (WDK adapters) **by default**, **P2P-delegate to a
  paired desktop optional**. No CLI.
- **Safety:** spend tools are `requiresConfirmation`; the Engine pauses for the
  host's `onConfirm`. Mobile → sheet, desktop → dialog, eval → auto-approve.

---

## 2. The mobile-optimized agent — a funnel

Mobile is resource-limited and tiny models are slow + weak at arguments (our
eval). So the agent **avoids making the model do the slow/weak parts**. Every
request flows through tiers; most never reach the LLM.

```
request
  │
  ├─ T0  Deterministic fast-path  (NO LLM)            ~instant
  │      skill selector + regex slot-fill → fire tool directly
  │      e.g. "balance", "receive address", "send 5k to bob"
  │
  ├─ T1  Single scoped LLM call                       1 inference
  │      skill narrows tools to 3-9 + few-shot → one tool call, streamed
  │      e.g. ambiguous single-tool asks
  │
  ├─ T2  Recipe-driven multi-step  (mobile multi-step!) ~1-2 inferences
  │      the SKILL is the plan; LLM only extracts slots + picks the rail;
  │      the engine runs the deterministic steps. (see §3)
  │
  └─ T3  P2P delegate to paired desktop                offloaded
         novel/complex chains run on the laptop's bigger model
```

### Why this works (from our data)
Tool **selection** is good even at 0.6B; **arguments + latency** are the pain.
So: deterministic routing/slot-filling handles the args, skill-scoping cuts the
latency, and the model is reserved for genuine ambiguity.

### Per-call optimizations (all tiers)
- **Skill-scoping** = fewer tools in context = less prefill = faster + more accurate.
- **Prefix/KV cache** the system+tools prefix across turns.
- **Few-shot** in skills → big arg-accuracy boost on tiny models, ~free.
- **Terse schemas + ContextBudget**, small `ctx_size` (sized by `capabilityProfile`).
- **Stream tokens + optimistic UI + warm-on-open** → feels instant.
- **Keep model resident during a session; unload after idle.**

---

## 3. Multi-step on mobile — "recipes, not planning"

A tiny model can't reliably plan *"pay bob 3 EUR"* (resolve → price → convert →
confirm → send) from scratch. So we don't ask it to.

**The skill carries the recipe; the model only fills the gaps.**

```
"pay bob 3 EUR"
   │  ONE structured LLM call (skill = payments):
   │     extract { recipient: "bob", amount: 3, currency: "EUR" } + choose rail
   ▼
   engine runs the recipe DETERMINISTICALLY (no model):
     resolve_contact("bob")  → { ln_address, preferred_layer }
     get_price(BTC, EUR)      → { eur_per_btc }
     fiat_to_sats(3, EUR)     → { sats: 5000 }
   ▼
   assemble send_payment(BTC, 5000, bob, layer)
   ▼  🔒 CONFIRM GATE → mobile sheet (amount, dest, rail) → user yes/no
   ▼
   send_payment(...)   → done, streamed result
```

- **~1–2 inferences** instead of 5. Deterministic steps cost nothing.
- **Reliable** on 0.6–4B because the hard part (the plan) is in the skill.
- **Graceful fallback:** no recipe match → full agentic loop (more inferences) or
  **delegate to desktop**.

### Two multi-step modes (both eval'd)
| Mode | Where | How |
|---|---|---|
| **Recipe** | mobile default | skill = ordered plan; 1 structured extraction + deterministic execution |
| **Free agentic** | desktop / delegated | model plans each step in a full loop |

Implementation: a lightweight **Recipe** abstraction — a skill may declare an
ordered list of steps (deterministic tool calls + the one LLM extraction). The
Engine runs it. If absent, fall back to free agentic.

---

## 4. The tool contract (§3 of ARCHITECTURE.md)

Per-layer namespaced (`spark_*`, `rln_*`, `arkade_*`, later `liquid_*`) +
cross-cutting router/helpers: `resolve_contact`, `get_price(asset,fiat?)`,
`fiat_to_sats`, `get_swap_quote`/`execute_swap`, and the unified
`send_payment(asset,amount,to,layer?)`. Spend tools flagged 🔒.

**Missing fns to add:** `resolve_contact`, `fiat_to_sats`,
`create_invoice(asset,amount,layer?)`, `send_payment`, `get_swap_quote`,
`execute_swap`.

---

## 5. Skills

Ship in core; load identically on both surfaces. They are the routing playbooks
**and** the multi-step recipes, with **few-shot** examples for small models:
- **payments** (recipe), **receive** (recipe), **swap** (recipe)
- **per-layer** (`spark`, `rln`, `arkade`) — tool list + when to pick that rail
- port **wallet-assistant** from kaleido-agent (already documents these flows)

---

## 6. Eval / model selection (Tracks A + B)

Run **per-surface configs** (mobile = `fc + skill`; desktop adds `mcp + cli`)
across models; report accuracy + thinking-time + reliability → **best model per
device**.
- **Track A — single-step** (tool decision): done (3 mechanisms, K-repeats,
  decision-only, reliability).
- **Track B — multi-step** (agentic chains): NEW. Grade coverage / order /
  final-args; safety is framework-enforced. **Also compare Recipe vs Free
  agentic** to prove the mobile optimization (recipe = higher success + far
  lower latency on tiny models).

---

## 7. Roadmap (phased)

| Phase | Deliverable | Status |
|---|---|---|
| **1. Spec** | ARCHITECTURE.md + this plan | ✅ |
| **2. Tool contract in core** | per-layer `ToolDef[]` + spend flags + missing fns | ✅ `wallet/contract.ts` |
| **3a. Desktop binding** | `kaleido-mcp` namespaced tools + `kaleido` CLI | ▢ |
| **3b. Mobile binding** | in-process handlers → Spark/RLN/Arkade WDK adapters | ▢ |
| **4. Skills + recipes** | payments/receive/swap (recipe + few-shot) + per-layer | ▢ |
| **5. Mobile funnel** | deterministic fast-path + slot-filling + Recipe engine | ▢ |
| **6. UX/perf** | warm-on-open, streaming, prefix-cache, idle-unload | ▢ |
| **7. Safety wiring** | flag spend tools; `onConfirm` sheet (mobile) + dialog (desktop) | partial (gate exists) |
| **8. Eval B + per-surface** | multi-step track; recipe vs free; best-model table | ▢ |
| **9. Delegation** | P2P offload of hard multi-step to desktop | partial (pairing exists) |
| **10. Fine-tune (stretch)** | LoRA a small model on our eval logs (QVAC Fabric) | ▢ |
| **11. Demo** | rate + desktop end-to-end on the contract | ▢ |

---

## 8. Success criteria

- **Latency:** "balance" ~instant (fast-path, no LLM); single-tool ask < ~3s
  perceived (stream); "pay bob 3 EUR" completes in ~1–2 inferences + confirm.
- **Accuracy:** the recommended mobile model resolves the seeded requests
  reliably (Track A + B), with args handled by slot-filling/recipe where the
  model is weak.
- **Safety:** no spend ever executes without the confirm gate firing.
- **Best-model table:** a clear per-device recommendation, with evidence that the
  mobile optimizations (fast-path, recipe, few-shot) measurably help.

## 9. What exists vs. what's new
- **Have:** Engine + ToolSources + Skills + ContextBudget + capabilityProfile +
  confirm gate + P2P pairing + Whisper + eval Track A + logs (fine-tune data).
- **New:** the per-layer contract; the deterministic fast-path + slot-filling;
  the Recipe engine (mobile multi-step); few-shot skills; per-surface eval +
  Track B; warm/cache/idle perf; the namespaced MCP + CLI mirror.
