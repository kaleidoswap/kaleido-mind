# kaleido-mind

> Sovereign AI for sovereign money. A local-first agent for Bitcoin, Lightning and RGB — voice-first, multi-L2 and designed for user-controlled hardware.

Built for the [QVAC Hackathon](https://dorahacks.io/hackathon/qvac-unleach-edge-ai-i/) by the [KaleidoSwap](https://kaleidoswap.com) team. LLM, embedding, STT and TTS inference runs through the [QVAC SDK](https://www.npmjs.com/package/@qvac/sdk), locally or on an explicitly paired user-controlled desktop. Optional wallet, trading, commerce and merchant-discovery tools may use the network and are [fully disclosed](./submission/remote-apis.yaml).

---

## What this is

`@kaleidorg/mind` is the reasoning + tool-calling engine that drives a **multi-L2 Bitcoin wallet** (Spark · RLN/RGB · Arkade · Liquid) with an on-device LLM. It runs the *same* agent on a phone and a laptop, and it's designed around one hard constraint: **tiny on-device models are slow and weak at arguments** — so we don't ask them to do the slow/weak parts.

Three ideas make that work:

1. **One tool contract, many transports.** The model sees identical tool names + schemas everywhere; only execution differs (mobile = in-process WDK adapters, desktop = a namespaced MCP + CLI, eval = contract-faithful stateful simulators). So skills are portable and benchmarks are honest.
2. **Recipes, not planning (with hybrid model use).** A small model can't reliably plan *"pay bob 3 EUR"* (resolve → price → convert → confirm → send). So a **skill carries the plan**; the model only fills the slots (~1 inference instead of 5, reliable on a 0.6B). For complex recipes (e.g. atomic swaps) slot extraction can be forced through the model for better natural-language understanding, with deterministic fallbacks to protect precision and reliability. Discovery skills (e.g. merchant-finder) are intentionally more model-leveraging.
3. **A tiered funnel.** Most requests never reach the model at all.

```
user request
  ├─ T0  fast-path     "balance" / "address" / "btc price"   → 0 inferences, instant
  ├─ T2  recipe        "pay bob 3 EUR" / "buy 0.001 BTC"      → ~1 inference (model may assist slot extraction for complex recipes), deterministic chain, confirm-gated
  └─ T1  agentic loop  everything else                        → skill-scoped LLM
        ↘ hard / novel chains can P2P-delegate to a paired desktop's bigger model
        (discovery flows like merchants intentionally use more model reasoning)
```

**Confirm-before-spend is structural:** every fund-moving tool is `requiresConfirmation` in the contract, so the engine pauses for the host's confirm sheet before any send — the model can't bypass it. The sheet gets a deterministic, voice-first **readback** (`confirmReadback` — *"Send 4,800 sats to bob over Spark. Confirm?"*) built from the resolved call, not the model, so unit/recipient mistakes surface where they're caught.

## Features

- **Multi-L2 wallet tool contract** — per-layer namespaced tools (`spark_*`, `rln_*`, `arkade_*`) + a cross-cutting router (`resolve_contact`, `get_price`, `fiat_to_sats`, `send_payment`, `get_swap_quote`/`execute_swap`). One source of truth in core.
- **Recipe engine** — deterministic multi-step (payments, swaps, atomic swaps, channel orders, asset-channel onboarding) that works on a 0.6B model; slot extraction can be model-assisted for complex cases with precision safeguards.
- **KaleidoSwap trading & onboarding** — one quote tool (`kaleidoswap_get_quote`) against the live maker; **atomic swaps** (RGB ↔ BTC) and **LSPS1 channel orders** (buy inbound liquidity, or a new asset channel pre-loaded with USDT/XAUT) drive the RGB Lightning Node — each a single confirm-gated recipe. *"buy 100 USDT"* onboards a channel-less user end to end.
- **Skills** — Agent-Skills-spec playbooks (`SKILL.md` + progressive disclosure) that scope tools and carry recipes; bundled for React Native. Some (e.g. merchant-finder for location/BTC Map) are intentionally more model-leveraging for natural language understanding, context, and result post-processing (via pluggable selectors including embeddings).
- **Tool sources** — in-process, MCP, CLI, and L402 (pay-per-call HTTP) — all behind one `ToolRegistry`.
- **Memory + RAG** — long-term recall and injected-embedding retrieval (Bitcoin copilot, wallet history, BTC-map discovery), all through QVAC. Memory **consolidates** near-duplicates (cheap on-device dedup, optional LLM merge on capable/delegated devices) so it doesn't bloat.
- **Hardware-aware** — picks the model + context budget for the device; P2P delegation for heavy work.
- **A product-level eval** — realistic scenarios run through the production
  Funnel with canonical contracts, confirmation decisions, observable side
  effects and raw local-inference receipts.

## The eval (what makes the claims defensible)

The headline benchmark is [Product Evaluation v3](./docs/EVALUATION_V3.md).
Twelve realistic wallet, trading, node, discovery and safety scenarios run
through the same production Funnel used by hosts. The harness binds canonical
tool contracts to deterministic stateful services and grades the complete
outcome: route, typed arguments, confirmation behavior, side effects and final
response.

```bash
kaleido-mind product-eval --models qwen3-0.6b
```

The older capability, planning, adversarial and raw-knowledge tracks remain
available as explicit engineering diagnostics. They are not combined into the
headline product-reliability score. See [docs/BENCHMARK.md](./docs/BENCHMARK.md).

The repository does not treat remembered or manually transcribed scores as evidence. Run `pnpm submission:evidence` to produce timestamped, unedited artifacts for the exact commit and hardware being submitted.

## Repo layout

```
kaleido-mind/
├── packages/
│   └── core/            @kaleidorg/mind — the engine
│       └── src/{wallet,recipe,fastpath,skills,tools,memory,rag,context,knowledge,providers}
├── apps/
│   ├── cli/             @kaleidorg/mind-cli (`kaleido-mind`) — model mgmt + product/diagnostic evals
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

# Product benchmark (--mock validates orchestration and grading without QVAC)
pnpm submission:evidence:mock
pnpm submission:evidence

# Optional legacy research diagnostics
pnpm submission:evidence -- --tracks safety,multistep,quality,capability

# Or exercise the engine directly against a model
pnpm play "pay bob 3 eur"
```

## Docs

- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — cross-surface design + the tool contract
- [ROADMAP.md](./docs/ROADMAP.md) — the master plan + phase status
- [BENCHMARK.md](./docs/BENCHMARK.md) — eval methodology, results, limitations
- [EVALUATION_V3.md](./docs/EVALUATION_V3.md) — product scenario schema and grading
- [MEMORY_RAG.md](./docs/MEMORY_RAG.md) — memory + retrieval
- [INTEGRATION.md](./docs/INTEGRATION.md) — embedding the engine in a host

## Hackathon tracks

- 📱 **Mobile** — the public `Rate` wallet runs the funnel, recipes, voice and confirmation gate on a physical iPhone through QVAC.
- 🖥️ **General Purpose** — the desktop sidecar runs the same engine and can serve as a paired, user-controlled QVAC inference peer.

The eval harness can test other QVAC-compatible GGUF models, but the submission
does not claim the Psy or Tinkerer tracks.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
