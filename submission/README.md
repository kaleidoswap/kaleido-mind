# QVAC Hackathon submission

kaleido-mind was built by the [KaleidoSwap](https://kaleidoswap.com) team for
the [QVAC Hackathon](https://dorahacks.io/hackathon/qvac-unleach-edge-ai-i/).
For developer documentation, see the [root README](../README.md) and the
[package README](../packages/core/README.md).

**[Demo video](https://youtu.be/pXhuw_DDHZA)**

## What was submitted

A local-first, agentic financial assistant for multi-layer Bitcoin wallets. It
trades, pays, onboards and finds merchants across Spark, RGB/Lightning and
Arkade, by chat or voice. LLM, embedding, STT and TTS inference runs through
the QVAC SDK, locally or on an explicitly paired desktop the user controls.
Optional wallet, trading, commerce and merchant-discovery tools may use the
network. They are all disclosed in [remote-apis.yaml](./remote-apis.yaml).

## Tracks

- **Mobile:** the public [Rate](https://github.com/kaleidoswap/Rate) wallet
  runs the funnel, recipes, voice loop and confirmation gate on a physical
  iPhone through QVAC. Wallet actions run through in-process WDK adapters
  (`spark_*`, `rln_*`, `arkade_*`). Heavy reasoning could be delegated over P2P
  to a paired desktop. That requires `@qvac/sdk` 0.13–0.18, the versions used
  for the submission.
- **General Purpose:** the
  [desktop app](https://github.com/kaleidoswap/desktop-app) runs the same
  engine over a local RGB Lightning Node, through a namespaced MCP and CLI. It
  manages the QVAC model lifecycle and can act as the inference peer a phone
  delegates to.

The eval harness can test other QVAC-compatible GGUF models, but the submission
does not claim the Psy or Tinkerer tracks.

## Evidence

The headline benchmark is [Product Evaluation v3](../docs/EVALUATION_V3.md):
twelve realistic scenarios run through the production funnel and are graded on
route, typed arguments, confirmation behavior, side effects and the final
response. The older capability, planning, adversarial and knowledge tracks
remain as diagnostics ([BENCHMARK.md](../docs/BENCHMARK.md)) and are not
combined into the headline score.

Scores are never transcribed by hand. Each run writes timestamped, unedited
artifacts for the exact commit and hardware:

```bash
pnpm submission:evidence:mock      # orchestration and grading, no model
pnpm submission:evidence           # real QVAC run
pnpm submission:evidence -- --tracks safety,multistep,quality,capability
```

- [evidence/](./evidence/README.md): the committed reference run and how to
  produce new ones
- [REPRODUCE.md](../REPRODUCE.md): clean build, reference hardware, real
  inference runs
- [remote-apis.yaml](./remote-apis.yaml): every network call an optional tool
  can make
