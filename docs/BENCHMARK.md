# KaleidoMind benchmark protocol

The benchmark is an executable protocol, not a table copied from an earlier
development run. Submission scores are valid only when accompanied by raw
artifacts from the exact public commit.

## Headline product benchmark

Product Evaluation v3 runs realistic requests through the production Funnel and
canonical tool contracts. It grades:

- route and orchestration tier;
- executed tool sequence and typed arguments;
- confirmation prompts and decisions;
- actual side effects;
- final grounded response;
- task completion, safety, latency and inference count.

The initial dataset contains twelve distinct scenarios rather than repeated
temperature-zero copies of the same prompt. See
[`EVALUATION_V3.md`](./EVALUATION_V3.md).

## Optional diagnostic tracks

| Diagnostic | Measures | CLI command |
|---|---|---|
| Capability | Isolated first-action selection across direct, broad and skill-scoped surfaces | `eval` |
| Multistep | Deterministic recipes versus free agentic planning | `multistep` |
| Adversarial | Unit errors, poisoned tool data, refusal and catastrophic actions | `safety` |
| Raw knowledge | Base-model fact coverage and concise explanation without product RAG | `quality` |

These diagnostics explain architecture and model behavior. They are not the
headline end-to-end product score.

## Reproduce

```bash
pnpm submission:evidence:mock
pnpm submission:evidence -- --models qwen3-0.6b,qwen3-1.7b,qwen3-4b

# Optional legacy diagnostics.
pnpm submission:evidence -- --tracks safety,multistep,quality,capability
```

Use `--quick` for a one-model rehearsal. The full run is sequential because the
QVAC worker owns one model lock.

## Required metadata

Every reported result must include:

- git commit;
- model filename and SHA-256;
- QVAC SDK version;
- generation configuration and context size;
- hardware model, OS and memory;
- load time, TTFT, duration, token counts, TPS and backend where available;
- scenario ids and dataset size;
- unedited stdout/stderr plus raw result files.

## Current submission results

Run artifacts are intentionally generated after the final code freeze. Do not
insert remembered preliminary values here. Link the chosen timestamped evidence
directory and summarize only values that can be recomputed from its raw files.

## Limitations

- Cases are authored and graded by the project team.
- Contract-faithful simulated services do not replace signet or mainnet
  end-to-end validation.
- The twelve-scenario pilot is intentionally small and does not estimate broad
  population accuracy.
- Natural paraphrases and a held-out set are planned after the pilot stabilizes.
- Desktop performance cannot be presented as phone performance.
- Thermal throttling and model-cache state can materially affect latency.
- A benchmark pass does not authorize autonomous spending; confirmation remains
  mandatory in the product.
