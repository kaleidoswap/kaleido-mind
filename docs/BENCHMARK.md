# Benchmark — function-calling harness

A reproducible bench for measuring **the right thing**: function-calling accuracy under real KaleidoMind conditions, on each candidate model and device.

This lives in `apps/bench/` and runs against the same `Engine` interface every consumer uses, so a passing bench is a passing model in production.

---

## What we measure

Four metrics, in priority order:

### 1. Tool-call accuracy (the headline)

Given an input + available tools, did the model pick the **right tool** with **valid args**?

- **Tool selection accuracy** — % of cases where the chosen tool name matches the gold label
- **Args validity** — % where args parse against the Zod schema without errors
- **Args correctness** — % where args match the gold args (semantic match — e.g. amount within tolerance)
- **Multi-turn coherence** — for chains, % of trajectories that reach the gold final state

### 2. Latency

- **First token time (TTFT)** — milliseconds from prompt submit to first emitted token
- **Tokens per second** (sustained)
- **End-to-end turn latency** — submit to final answer (incl. tool dispatch)

### 3. Resource usage

- Peak RAM during a turn
- Peak swap / wired memory on macOS
- Battery draw on mobile (mWh per turn, where measurable)
- Cold-start time (model load → first token ready)

### 4. Refusal / safety

- **Should-refuse rate** — on a curated adversarial set, % the model correctly refuses
- **Should-act rate** — on benign requests, % the model acts without over-refusing

---

## Datasets

Three layered eval sets, all live in `apps/bench/datasets/`:

| Set | Size | Source | Purpose |
|---|---|---|---|
| `kaleido-eval-v0` | 100 hand-curated turns | Built by us | Domain regression — never regress on these |
| `apigen-mt-holdout` | ~500 turns | 10% holdout of APIGen-MT-5k | General FC competence — guard rail |
| `adversarial-v0` | 30 turns | Synthetic, prompt-injection + scam patterns | Safety floor |

Records share the JSONL schema in `packages/core/src/logger.ts` (APIGen-MT compatible).

---

## Candidate models — initial sweep

Desktop (M4 24 GB):

| Model | Quant | RAM | Expected tok/s | Notes |
|---|---|---|---|---|
| **Qwen3-30B-A3B** | Q4_K_M | ~16 GB | ~25 | **Primary** — MoE, 30B params, only 3B active per token |
| Qwen3-14B-Instruct | Q5_K_M | ~10 GB | ~22 | Dense alternative, lower memory |
| Qwen3-8B-Instruct | Q6_K | ~7 GB | ~30 | If MoE plumbing is an issue in QVAC |
| xLAM-2-8b | Q5_K_M | ~6 GB | ~30 | FC specialist, trained on APIGen-MT |
| Hermes-4-Llama-3.1-8B | Q6_K | ~7 GB | ~25 | Agentic-tuned, JSON-mode native |
| Psy variants | TBD | TBD | TBD | Test first — hackathon scoring bonus |

Mobile (iPhone 15 Pro / equivalent Android):

| Model | Quant | RAM | Expected tok/s | Notes |
|---|---|---|---|---|
| **Qwen3-4B-Instruct** | Q4_K_M | ~2.4 GB | ~12 | **Primary** default |
| Qwen3-1.7B-Instruct | Q5_K_M | ~1.1 GB | ~25 | Snappier fallback |
| Qwen3-8B-Instruct | Q4_K_M | ~5 GB | ~6 | Flagship-only, slower |
| xLAM-2-3b | Q5_K_M | ~1.9 GB | ~18 | FC specialist |
| Hermes-3-Llama-3.2-3B | Q5_K_M | ~2 GB | ~15 | Agentic 3B |
| Psy small variants | TBD | TBD | TBD | First-class candidate |

---

## How to run

```bash
# Single model, all sets
pnpm bench --model=qwen3-30b-a3b-q4 --device=mac-m4

# Sweep all candidates on a device
pnpm bench:sweep --device=mac-m4

# Compare two snapshots
pnpm bench:diff results/qwen3-14b.json results/qwen3-30b-a3b.json
```

Output: `results/<device>/<model>-<timestamp>.json` + a markdown summary in `results/<device>/SUMMARY.md` that gets committed.

---

## What "passing" looks like

A model is **production-ready** for KaleidoMind when it clears the floor on `kaleido-eval-v0`:

| Metric | Floor (Phase 1) | Goal (Phase 3) |
|---|---|---|
| Tool selection accuracy | ≥ 85% | ≥ 95% |
| Args validity | ≥ 90% | ≥ 98% |
| Args correctness | ≥ 75% | ≥ 90% |
| Should-refuse rate | ≥ 80% | ≥ 95% |
| TTFT (desktop) | ≤ 1.5 s | ≤ 800 ms |
| TTFT (mobile) | ≤ 3.0 s | ≤ 1.8 s |
| End-to-end turn latency (typical) | ≤ 6 s | ≤ 3 s |

A model below the floor is not shipped, period.

---

## When to bench

- **Every model upgrade.** Before swapping the default.
- **Every quant change.** Q4 vs Q5 vs Q6 — measure, don't guess.
- **Before any fine-tune.** Lock the baseline so we can prove the fine-tune helped.
- **After fine-tune.** Same harness, must not regress on the holdout sets.
- **On every Mind release.** CI runs a fast subset (10 turns) as a smoke test.

---

## What we ship at submission

1. The `apps/bench/` harness, runnable on any machine
2. `results/mac-m4/SUMMARY.md` — full sweep on the demo machine
3. `results/iphone-15-pro/SUMMARY.md` — full sweep on the demo phone
4. A chart in the submission: "Qwen3-30B-A3B vs Psy vs the rest" across the four metric families

This turns a vague claim ("we run AI locally") into a defensible one ("we measured X, on Y, against Z").
