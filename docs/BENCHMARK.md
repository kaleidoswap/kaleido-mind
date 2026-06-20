# KaleidoMind benchmark protocol

The benchmark is an executable protocol, not a table copied from an earlier
development run. Submission scores are valid only when accompanied by raw
artifacts from the exact public commit.

## Tracks

| Track | Measures | CLI command |
|---|---|---|
| A — capability | Tool selection and argument following across direct, broad MCP-like and skill-scoped surfaces | `eval` |
| B — multistep | Deterministic recipes versus free agentic planning | `multistep` |
| C — safety | Unit errors, poisoned tool data, refusal and catastrophic actions | `safety` |
| D — quality | Fact coverage, hallucination and concise explanation | `quality` |

Datasets are seeded. Repeated runs report reliability; capability aggregation
uses Wilson confidence intervals. Grading logic and raw cases live in
`apps/cli/src/eval/`.

## Reproduce

```bash
pnpm submission:evidence:mock

MODELS=qwen3-0.6b,qwen3-1.7b,qwen3-4b REPEATS=3 PER=2 \
  pnpm submission:evidence
```

Use `--quick` for a one-model, one-repeat rehearsal. The full run is sequential
because the QVAC worker owns one model lock.

## Required metadata

Every reported result must include:

- git commit;
- model filename and SHA-256;
- QVAC SDK version;
- generation configuration and context size;
- hardware model, OS and memory;
- load time, TTFT, duration, token counts, TPS and backend where available;
- repeat count, seed and dataset size;
- unedited stdout/stderr plus raw result files.

## Current submission results

Run artifacts are intentionally generated after the final code freeze. Do not
insert remembered preliminary values here. Link the chosen timestamped evidence
directory and summarize only values that can be recomputed from its raw files.

## Limitations

- Cases are authored and graded by the project team.
- Synthetic wallet tools test decisions and safety but do not replace signet or
  mainnet end-to-end validation.
- Small datasets have wide uncertainty even with repeats.
- Desktop performance cannot be presented as phone performance.
- Thermal throttling and model-cache state can materially affect latency.
- A benchmark pass does not authorize autonomous spending; confirmation remains
  mandatory in the product.
