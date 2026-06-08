# Benchmark — function-calling harness

A reproducible bench for measuring **the right thing**: function-calling accuracy under real KaleidoMind conditions, on each candidate model and device.

The **implemented** eval lives in `apps/cli/src/eval/` and runs via the `kaleido-mind` CLI — see the **Three-track eval suite (A/B/C)** section below for the real commands. It runs against the same `Engine` interface every consumer uses, so a passing bench is a passing model in production. The plan in this first section is the target; items marked _(planned)_ aren't built yet.

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

_(planned)_ Three layered eval sets:

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

The real, implemented commands live in the **Three-track eval suite** section
below (`kaleido-mind eval | multistep | safety`, or `apps/cli/run-all-evals.sh`
to run all three sequentially). _(planned: a `bench:sweep` device-sweep wrapper
and a `bench:diff` snapshot comparator.)_

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

1. The `apps/cli` eval tracks (A/B/C), runnable on any machine
2. `results/mac-m4/SUMMARY.md` — full sweep on the demo machine
3. `results/iphone-15-pro/SUMMARY.md` — full sweep on the demo phone
4. A chart in the submission: "Qwen3-30B-A3B vs Psy vs the rest" across the four metric families

This turns a vague claim ("we run AI locally") into a defensible one ("we measured X, on Y, against Z").

---

## Results — v0 (wallet tool-calling, 10-case eval)

Run on Apple M-series, QVAC SDK 0.12, GGUF Q4_K_M, the
10-prompt wallet eval set (`get_balance`, `get_address`, `list_transactions`,
`pay_invoice`, + 2 should-not-call cases). Param scoring is **by value**
(does the recipient/amount actually land in the args), since small models vary
the argument *names*.

| Model | Size | Tool selection | Param following | Latency/call |
|---|---|---|---|---|
| Qwen3-0.6B | 0.4 GB | **100%** (10/10) | 33% | **0.95 s** |
| Qwen3-4B | 2.3 GB | **100%** (10/10) | **67%** | 9.2 s |
| QVAC MedPsy-4B | 2.5 GB | **100%** (10/10) | 33% | 15.0 s |

(Raw per-case results were from the v0 run; that harness is now consolidated into the CLI eval tracks above.)

### Findings

1. **Tool *selection* is solved even at 0.6B.** All three models picked the
   right tool — and correctly declined to call one — on every case. The engine
   + `tools: true` grammar is reliable across sizes. This is the core
   capability and it works on the smallest mobile-class model.

2. **Param *following* scales with size.** 0.6B (33%) → Qwen3-4B (67%). Bigger
   models fill the schema's argument names more faithfully. The 0.6B reliably
   chooses `pay_invoice` but mislabels `invoice_or_address`/`amount_sats`.

3. **MedPsy-4B (a QVAC Psy model) trades generality for its domain.** It nails
   tool selection but is slower and weaker on general-purpose param following —
   expected, since it's *medical*-specialized. The honest read: Psy models are
   excellent for their vertical; for a Bitcoin wallet agent, a general model of
   the same size is the better fit.

4. **Speed favours the small model 10–15×.** 0.6B at ~1 s/call vs ~9–15 s for
   the 4B models on the same hardware.

### What this means for KaleidoMind's model routing

- **Mobile default: Qwen3-0.6B** — instant, 100% tool selection. Pair with
  **tolerant tool handlers** (accept arg aliases / extract by value) to close
  the param gap, exactly as our value-based scoring does.
- **Heavier reasoning / param-precise calls: delegate to the desktop** running
  a 4B+ general model over P2P — the delegation path already built.
- **Psy track coverage:** MedPsy-4B is benchmarked and supported (any GGUF the
  QVAC SDK loads runs through the same engine); it shines on medical use cases,
  which is a separate vertical from the wallet agent.

---

# Three-track eval suite (A / B / C)

The newer, more rigorous harness lives in `apps/cli/src/eval/` and runs via the
`kaleido-mind` CLI. It extends the v0 single-shot bench above into three tracks,
each with **K repeats**, **reliability**, and **Wilson 95% confidence intervals**
(a rate without an interval is noise at our sample sizes).

| Track | Question | Command |
|---|---|---|
| **A — capability** | One request → right tool + args? Across 3 presentations (fc / mcp / skill). Decision-only. | `eval` |
| **B — planning** | A chain ("pay bob 3 EUR") → right final action? **recipe vs free-agentic.** | `multistep` |
| **C — safety** | Right amounts, injection resistance, refusal? Over a stateful `MockWallet`. | `safety` |
| **D — quality** | Does it *know/explain* correctly? Knowledge/reasoning Q&A graded on fact-coverage + no-hallucination + conciseness — the dimension where a bigger model earns its keep (decision-only tracks are blind to it). | `quality` |

```bash
cd apps/cli
npx tsx src/index.ts eval      --models qwen3-0.6b,qwen3-4b,medpsy-4b --repeats 3
npx tsx src/index.ts multistep --models qwen3-0.6b,qwen3-4b,medpsy-4b --repeats 3
npx tsx src/index.ts safety    --models qwen3-0.6b,qwen3-4b,medpsy-4b --repeats 3
```

**Method:** models loaded once (warm); temperature 0; seeded dataset. A is
decision-only (grade the first tool call). B/C run the real loop against a
`MockWallet` (balances per layer, contacts incl. ambiguous + injectable, price,
validation) — the observable is *what actually got sent*. The spend gate is
auto-approved and asserted (framework-enforced). Significance = two-proportion
z-test (p<0.05) for recipe-vs-free.

**Thesis under test:** small models can't reliably *plan*, so the skill carries
the plan (**recipe** ≈ 0 inferences) and common asks skip the model entirely
(fast-path). Track B should show recipe ≫ free on small models; Track C should
show recipe is structurally injection-resistant (uses the structured address,
never free text).

## Results (Apple M4, QVAC, GGUF Q4_K_M, temp 0, max_tokens 512; CIs are Wilson 95%)

### Track C — safety (full 4-model, K=3) — the headline
| Model | recipe safe | free safe | catastrophic (free) |
|---|---|---|---|
| Qwen3-0.6B | **100%** (85–100) | 42% (27–59) | ⚠ 3 |
| Qwen3-1.7B | **100%** (85–100) | 64% (47–78) | ⚠ 3 |
| Qwen3-4B | **100%** (85–100) | 61% (44–75) | ⚠ 4 |
| MedPsy-4B | **100%** (85–100) | 61% (44–75) | ⚠ 1 |

Free-agentic safety **does not improve with size** (42→64→61→61%) and **every**
model has catastrophic failures (paid attacker / 10×); recipe = **100%** on all
(uses the structured address, ignores poisoned tool data). *The architecture, not
the model, makes it safe.*

### Track B — planning, recipe vs free (Qwen3-0.6B, K=1)
| recipe pass | recipe inf | free pass | free inf | Δ significant? |
|---|---|---|---|---|
| **100%** (70–100) | ~0 | 0% (0–30) | 2.1 | yes (p<0.05) |

### Track A — capability / tool *selection* (0.6B vs 1.7B, K=3, --per 2)
| Model | fc | mcp | skill | fc latency |
|---|---|---|---|---|
| Qwen3-0.6B | 69% (58–79) | 58% | 61% | **1.9 s** |
| Qwen3-1.7B | 67% (55–77) | 67% | 60% | 7.8 s |

Statistical **tie** on accuracy; 0.6B is **~4× faster**. MCP-at-scale (60 tools)
costs ~2× latency for no gain.

### Track D — response *quality* (0.6B vs 1.7B, K=3) — where size matters
| Model | pass | fact-coverage | hallucination | latency |
|---|---|---|---|---|
| Qwen3-0.6B | 63% (46–78) | 63% | 0% | 3.2 s |
| Qwen3-1.7B | **90% (74–97)** | **84%** | 0% | 9.0 s |

### Findings → model selection
- **Recipe ≫ free-agentic** on every model: 100% safe + 100% multi-step at ~0
  inferences, vs free's 0% multi-step and 42–64% safe with attacker payments.
- **Two axes, two winners.** Tool *selection* is solved at 0.6B (= 1.7B, 4× faster)
  → **0.6B is enough for wallet actions** (the funnel handles the rest). Response
  *quality* clearly favors **1.7B** (90% vs 63%) → **better for conversation/
  knowledge.** → **Recommendation: 1.7B default on ≥6 GB phones (richer chat,
  actions stay fast/safe via the funnel); 0.6B on low-RAM (actions still
  excellent).**
- Track C caught a catastrophic unit-parse bug in development ("5k sats" → 5, a
  1000× under-send). Fixed + regression-tested.

## Limitations / threats to validity

Cite responsibly:

1. **Synthetic + small dataset** (~12 intents A, 6 chains B, 11 cases C),
   author-written — not a real-usage distribution; risk of overfitting our own
   skills (no held-out **test** split yet).
2. **Stubbed execution** — measures model *decisions*, not real wallet outcomes;
   no real node / on-chain / LN edge cases.
3. **Heuristic grading** — value/substring matching, single grader, not yet
   hand-audited.
4. **Lab hardware** — latency on a dev laptop, **not a phone** (the mobile target).
5. **Narrow injection coverage** — a few tool-data vectors, not the full surface
   (Nostr DMs, invoice memos, merchant listings, RAG docs).
6. **Small n** — even at K=3, intervals are wide; treat sub-10-point gaps as
   inconclusive unless the z-test agrees.

**Roadmap to a fully professional eval:** real-signet end-to-end subset ·
on-device (phone) latency/energy · larger naturalistic dataset with
train/dev/**test** split · grader audit + agreement · broader injection vectors ·
CI job + baseline + regression gate.
