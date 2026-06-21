# KaleidoMind — QVAC Hackathon Submission

**Sovereign AI for sovereign money.** KaleidoMind is an Apache-2.0,
local-first reasoning and tool-calling engine for a multi-layer Bitcoin wallet.
The same engine powers a desktop application, the Rate React Native wallet and
an autonomous wallet agent.

**Tracks:** General Purpose and Mobile.

## Why it exists

Wallet requests are multi-step, money is unforgiving, and mobile-sized models
are not reliable planners. KaleidoMind moves known workflows into deterministic
recipes and reserves the model for intent, language and novel reasoning:

```text
request
  ├─ fast path: common reads, zero inference
  ├─ recipe: deterministic multi-step workflow, confirmation-gated
  └─ agentic: skill-scoped QVAC model + tools
```

Spend-capable tools are marked in the shared contract. The host must approve
them before execution; a model cannot bypass that gate.

## QVAC usage

All LLM, embedding, speech-to-text and text-to-speech inference uses
`@qvac/sdk`. Inference is local by default. A phone may explicitly delegate to
a paired, user-controlled desktop through QVAC's P2P transport. No hosted AI
provider is used.

Wallet nodes, model downloads, trading, commerce and merchant discovery can use
ordinary network APIs. They are optional, are not inference providers, and are
listed in [`submission/remote-apis.yaml`](./submission/remote-apis.yaml).

## Product surfaces

- **General Purpose:** desktop sidecar with local QVAC model lifecycle,
  namespaced tools, skills, recipes, telemetry and phone pairing.
- **Mobile:** Rate on a physical iPhone, with local QVAC inference, Whisper,
  TTS, wallet tool execution and structural confirmation.
- **Agent:** an autonomous optimizer surface — risk-gated task scheduling, run
  logs and optimizer skills — that drives the same engine without a human in
  every loop, while spend-capable tools still pause for host confirmation.
- **Engine:** `@kaleidorg/mind`, shared by all surfaces.

## Auditable evidence

`kaleidomind.evidence.v1` JSONL records:

- model load/unload;
- prompt and response;
- prompt/completion/total tokens;
- time to first token, duration and tokens/second;
- actual CPU/GPU backend when supplied by QVAC;
- tool calls/results and confirmation decisions;
- cancellation, truncation and errors.

Payment material is sanitized before export. The benchmark command writes
timestamped manifests and unedited output:

```bash
pnpm submission:evidence:mock
pnpm submission:evidence -- --models qwen3-0.6b,qwen3-1.7b,qwen3-4b
```

No score is claimed unless its raw run, exact commit and hardware metadata are
included in the submission evidence.

The default evidence run is Product Evaluation v3: realistic scenarios through
the production Funnel and canonical contracts, graded on complete outcome,
confirmation correctness and successful side effects. Legacy mechanism and
raw-knowledge tracks are retained only as optional diagnostics.

## Standard hardware

- Desktop: MacBook Air `Mac16,12`, Apple M4 (10 cores), 24 GB unified memory,
  macOS 26.5.1.
- Mobile: standard iPhone 17. Exact iOS, storage, power and thermal state are
  captured during the physical-device run.

## Reproduction

See [`REPRODUCE.md`](./REPRODUCE.md). The short path is:

```bash
git clone https://github.com/kaleidoswap/kaleido-mind.git
cd kaleido-mind
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm submission:evidence:mock
```

## Roadmap

The hackathon build is a foundation. Two tracks follow directly from it:

- **A real local-first personal assistant.** Deepen the agentic tier into a
  genuine assistant: long-horizon planning and memory, on-device retrieval
  (local RAG over the user's wallet history, documents and contacts) and a
  stronger autonomous mode that proposes and executes multi-step workflows under
  the same host-enforced confirmation gates. The agent stops being a wallet
  command line and becomes an assistant that holds context.

- **A measurement and fine-tuning loop for edge models.** Turn the evidence
  harness into a data and evaluation flywheel: collect anonymized, sanitized
  traces; build synthetic datasets for wallet tasks; and fine-tune small,
  shippable models. Run a benchmark matrix across the combinations that actually
  decide reliability on-device — function calling vs. MCP vs. skills, and
  reasoning modes (no-think, short chain-of-thought, extended thinking) — so the
  Funnel can route each request to the cheapest mode that still succeeds.

## Prior work

KaleidoSwap, Rate and parts of the wallet/tooling stack pre-date the hackathon.
Hackathon work includes the shared KaleidoMind engine, QVAC inference and P2P
delegation, tiered funnel, recipes, skills, safety gates, evidence telemetry,
evaluation harness and cross-surface integration. Public repository history is
the audit trail.

## Team

Walter, Arshia, Mo and Emil — KaleidoSwap, Italy / Europe.
