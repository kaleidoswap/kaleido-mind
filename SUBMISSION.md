# KaleidoMind — QVAC Hackathon Submission

**Sovereign AI for sovereign money.** KaleidoMind is an Apache-2.0,
local-first reasoning and tool-calling engine for a multi-layer Bitcoin wallet.
The same engine powers a desktop application and the Rate React Native wallet.

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
- **Engine:** `@kaleidorg/mind`, shared by both surfaces.

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
MODELS=qwen3-0.6b,qwen3-1.7b,qwen3-4b REPEATS=3 PER=2 \
  pnpm submission:evidence
```

No score is claimed unless its raw run, exact commit and hardware metadata are
included in the submission evidence.

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

## Prior work

KaleidoSwap, Rate and parts of the wallet/tooling stack pre-date the hackathon.
Hackathon work includes the shared KaleidoMind engine, QVAC inference and P2P
delegation, tiered funnel, recipes, skills, safety gates, evidence telemetry,
evaluation harness and cross-surface integration. Public repository history is
the audit trail.

## Team

Walter, Arshia, Mo and Emil — KaleidoSwap, Italy / Europe.
