# kaleido-mind

> Sovereign AI for sovereign money. A local-first agent for Bitcoin, Lightning and RGB — voice-first, multi-L2, fully private. Runs on your phone and laptop, never in someone else's cloud.

Built for the [QVAC Hackathon](https://dorahacks.io/hackathon/qvac-unleach-edge-ai-i/) by the [KaleidoSwap](https://kaleidoswap.com) team. All inference runs through the [QVAC SDK](https://www.npmjs.com/package/@qvac/sdk) — no cloud, no API keys.

---

## What this is

`@kaleidorg/mind` is the reasoning + tool-calling engine that drives a **multi-L2 Bitcoin wallet** (Spark · RLN/RGB · Arkade · Liquid) with an on-device LLM. It runs the *same* agent on a phone and a laptop, and it's designed around one hard constraint: **tiny on-device models are slow and weak at arguments** — so we don't ask them to do the slow/weak parts.

Three ideas make that work:

1. **One tool contract, many transports.** The model sees identical tool names + schemas everywhere; only execution differs (mobile = in-process WDK adapters, desktop = a namespaced MCP + CLI, eval = stubs). So skills are portable and benchmarks are honest.
2. **Recipes, not planning.** A small model can't reliably plan *"pay bob 3 EUR"* (resolve → price → convert → confirm → send). So a **skill carries the plan**; the model only fills the slots. ~1 inference instead of 5, reliable on a 0.6B.
3. **A tiered funnel.** Most requests never reach the model at all.

```
user request
  ├─ T0  fast-path     "balance" / "address" / "btc price"   → 0 inferences, instant
  ├─ T2  recipe        "pay bob 3 EUR" / "buy 0.001 BTC"      → ~1 inference, deterministic chain, confirm-gated
  └─ T1  agentic loop  everything else                        → skill-scoped LLM
        ↘ hard / novel chains can P2P-delegate to a paired desktop's bigger model
```

**Confirm-before-spend is structural:** every fund-moving tool is `requiresConfirmation` in the contract, so the engine pauses for the host's confirm sheet before any send — the model can't bypass it. The sheet gets a deterministic, voice-first **readback** (`confirmReadback` — *"Send 4,800 sats to bob over Spark. Confirm?"*) built from the resolved call, not the model, so unit/recipient mistakes surface where they're caught.

## Features

- **Multi-L2 wallet tool contract** — per-layer namespaced tools (`spark_*`, `rln_*`, `arkade_*`) + a cross-cutting router (`resolve_contact`, `get_price`, `fiat_to_sats`, `send_payment`, `get_swap_quote`/`execute_swap`). One source of truth in core.
- **Recipe engine** — deterministic multi-step (payments, swaps) that works on a 0.6B model.
- **Skills** — Agent-Skills-spec playbooks (`SKILL.md` + progressive disclosure) that scope tools and carry recipes; bundled for React Native.
- **Tool sources** — in-process, MCP, CLI, and L402 (pay-per-call HTTP) — all behind one `ToolRegistry`.
- **Memory + RAG** — long-term recall and injected-embedding retrieval (Bitcoin copilot, wallet history, BTC-map discovery), all through QVAC. Memory **consolidates** near-duplicates (cheap on-device dedup, optional LLM merge on capable/delegated devices) so it doesn't bloat.
- **Hardware-aware** — picks the model + context budget for the device; P2P delegation for heavy work.
- **A real eval** — three benchmark tracks with confidence intervals (below).

## The eval (what makes the claims defensible)

Three tracks via the `kaleido-mind` CLI, each with K repeats + Wilson 95% CIs. See [docs/BENCHMARK.md](./docs/BENCHMARK.md).

| Track | Question | Command |
|---|---|---|
| **A — capability** | One request → right tool + args? (fc / mcp / skill) | `kaleido-mind eval` |
| **B — planning** | A chain → right final action? **recipe vs free-agentic** | `kaleido-mind multistep` |
| **C — safety** | Right amounts, injection resistance, refusal? | `kaleido-mind safety` |

The headline result: **recipes resolve ≈100% at ~0 inferences across every model**, while free-agentic success drops on small models — quantified evidence that the funnel is the right call for mobile. Track C is adversarial (prompt-injection via poisoned tool data, unit-error catastrophes) and already caught a real 1000× under-send bug in development.

## Repo layout

```
kaleido-mind/
├── packages/
│   └── core/            @kaleidorg/mind — the engine
│       └── src/{wallet,recipe,fastpath,skills,tools,memory,rag,context,knowledge,providers}
├── apps/
│   ├── cli/             @kaleidorg/mind-cli (`kaleido-mind`) — model mgmt + the 3 eval tracks
│   ├── provider/        desktop sidecar (Tauri) — namespaced MCP + CLI host
│   └── playground/      exercise the engine against a real local model, no phone needed
└── docs/                ARCHITECTURE · ROADMAP · BENCHMARK · MEMORY_RAG · INTEGRATION · …
```

Consumers live in sibling repos: **`rate`** (React Native wallet, Mobile track) and the **desktop app** (General Purpose track), both binding the same contract.

## Quickstart

```bash
pnpm install && pnpm -r build

# The CLI: manage on-device models + run the agent
cd apps/cli
npx tsx src/index.ts setup            # guided first-run: pick + pull a model
npx tsx src/index.ts run "what's my balance?"
npx tsx src/index.ts skills           # list installed skills

# Benchmarks (all tracks; --mock runs offline with no model)
./run-all-evals.sh                    # C → B → A, sequential (QVAC single-lock)
npx tsx src/index.ts multistep --mock # quick offline sanity check

# Or exercise the engine directly against a model
pnpm play "pay bob 3 eur"
```

## Docs

- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — cross-surface design + the tool contract
- [ROADMAP.md](./docs/ROADMAP.md) — the master plan + phase status
- [BENCHMARK.md](./docs/BENCHMARK.md) — eval methodology, results, limitations
- [MEMORY_RAG.md](./docs/MEMORY_RAG.md) — memory + retrieval
- [INTEGRATION.md](./docs/INTEGRATION.md) — embedding the engine in a host

## Hackathon tracks

- 📱 **Mobile** — the `rate` wallet runs the agent fully on-device (Qwen3-0.6B), funnel + recipes + confirm gate.
- 🖥️ **General Purpose** — the desktop sidecar with a namespaced MCP, CLI, and bigger models for delegation.
- 🩺 **Psy / MedPsy** — QVAC MedPsy models run through the same engine (benchmarked in Track A).
- 🛠️ **Tinkerer** — the three-track eval harness, the Recipe engine, and the wallet tool contract are all reusable.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
