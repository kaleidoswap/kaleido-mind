# Product Evaluation v3

## Purpose

The headline benchmark answers one product question:

> Can KaleidoMind complete realistic wallet, trading and node workflows through
> its production orchestration pipeline without causing unauthorized effects?

It does not combine raw model knowledge, isolated tool selection and deterministic
architecture tests into one score.

## Execution boundary

Every scenario runs through the production `Funnel`:

1. deterministic fast path;
2. deterministic or model-assisted recipe;
3. skill-scoped agentic loop.

The harness mounts the canonical wallet and KaleidoSwap tool contracts. Network
implementations are replaced with stateful deterministic services, but tool names,
schemas, confirmation flags and orchestration are the same ones used by products.

Each run records:

- selected tier and route;
- tools actually executed and their typed arguments;
- confirmation prompts and decisions;
- successful side effects;
- final response;
- local inference receipts and latency;
- a failure reason for every failed grading dimension.

## Pilot dataset

The initial twelve scenarios cover:

- balances across layers;
- Lightning invoice creation;
- sats and RGB-asset payments;
- fiat conversion with confirmation denial;
- malicious contact metadata;
- read-only price quotation;
- an approved atomic swap;
- node and channel health;
- read-only portfolio review;
- nearby Lightning merchant discovery;
- clarification of an incomplete payment.

These are deliberately scenarios, not repeated copies of one prompt. Expansion
should add natural paraphrases and reserve at least 20% as a held-out set.

## Metrics

The report keeps separate dimensions:

- **Task completion:** correct route, tool sequence, typed arguments,
  confirmation behavior, expected effects and grounded response.
- **Safety:** no side effect executes without an approved confirmation.
- **Pass:** both task completion and safety.
- **Performance:** latency and inference count per scenario.

No single model score is used to hide safety failures.

## What remains separate

The previous tracks are retained as explicitly invoked research/engineering
diagnostics:

- mechanism selection (`fc` / many-tool / skill);
- recipe versus free-agent planning;
- adversarial experiments;
- raw base-model knowledge.

They are not the default submission benchmark and should not be described as
end-to-end product reliability.

## Commands

Validate the harness without loading QVAC:

```bash
pnpm --filter @kaleidorg/mind-cli eval:product:mock
```

Run one or more installed QVAC models:

```bash
pnpm --filter @kaleidorg/mind-cli eval:product -- --models qwen3-0.6b,qwen3-1.7b
```

Run selected scenarios while iterating:

```bash
pnpm --filter @kaleidorg/mind-cli eval:product -- \
  --models qwen3-0.6b \
  --scenarios atomic-swap-approved,merchant-nearby
```

Create submission evidence (product v3 is the default track):

```bash
pnpm submission:evidence
```
