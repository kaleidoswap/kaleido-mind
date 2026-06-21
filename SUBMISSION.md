# KaleidoMind — QVAC Hackathon Submission

**Sovereign AI for sovereign money.** KaleidoMind is an Apache-2.0,
local-first **agentic financial assistant for multi-layer Bitcoin wallets**. It
runs on your own hardware, holds no keys of its own, and helps you trade, pay,
onboard liquidity, discover merchants and read your portfolio across Bitcoin's
L2s — Spark, RGB/Lightning and Arkade — by chat or by voice, with no cloud model
and no custodian. The same assistant powers a desktop application, the Rate
React Native wallet and an autonomous agent.

**Tracks:** General Purpose and Mobile.

**Project site:** <https://kaleidoswap.github.io/kaleido-mind/>

## What it is

A wallet you can talk to. Ask it to *"buy 100 USDT,"* *"swap 0.001 BTC,"*
*"pay Alice 5,000 sats,"* or *"find somewhere to spend Bitcoin nearby,"* and it
carries out the whole multi-L2 workflow on-device — choosing the right layer,
pricing the trade, onboarding a channel if you need one, and reading the action
back before it touches your money. It is an assistant first: voice-native,
context-aware, and entirely yours.

## How it stays reliable on a small on-device model

The assistant is only as good as it is trustworthy with real money on a phone-
sized model. KaleidoMind earns that trust with a tiered design — instant reads,
deterministic recipes for known workflows, and the model reserved for intent,
language and novel reasoning:

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

- **General Purpose — desktop app:** an RGB/Lightning trading wallet whose funds
  live on a local **RGB Lightning Node (RLN)** the app runs and unlocks. The
  desktop hosts the engine as a namespaced MCP + CLI, drives the node through
  `rln_*` tools, manages the QVAC model lifecycle, and can act as the paired
  inference peer a phone delegates to.
- **Mobile — Rate:** a React Native wallet on a physical iPhone. The agent runs
  fully on-device (QVAC LLM + Whisper STT + neural TTS) and executes wallet
  actions through **in-process WDK adapters** — no server round-trip for tool
  execution. Voice mode is a real hands-free loop; see below.
- **Agent:** an autonomous optimizer surface — risk-gated task scheduling, run
  logs and optimizer skills — that drives the same engine without a human in
  every loop, while spend-capable tools still pause for host confirmation.
- **Engine:** `@kaleidorg/mind`, shared by all surfaces.

## On mobile: WDK execution, voice and modes

**WDK execution (on-device).** On Rate the model never reaches a wallet backend
directly. It emits a canonical tool call (`spark_*`, `rln_*`, `arkade_*`); the
host runs it through an in-process **WDK adapter** that talks to the right L2 —
Spark, RGB Lightning, or Arkade — and returns a contract-shaped result. Tool
*execution* is local code; only the underlying chain/wallet backends are
network services (disclosed in [`submission/remote-apis.yaml`](./submission/remote-apis.yaml)).

**Voice mode.** A genuine hands-free conversation loop: QVAC's Whisper VAD
session transcribes raw-PCM mic frames, the engine reasons and selects tools,
and on-device QVAC TTS (with a system-voice fallback) speaks the reply —
*listening → thinking → speaking → listening*, mic-gated during playback. The
confirm readback is spoken, so a spend is heard before it happens.

**Brain modes.** A top-level toggle: **Auto** (delegates per query when a paired
desktop is reachable and the work is heavy), **Always local** (privacy-max,
never delegates), **Always desktop** (delegate when reachable, fall back to
local). A separate **thinking-mode** control trades latency for reasoning depth.

**Models.** On a phone the realistic on-device model today is **Qwen3 1.7B** —
it runs comfortably on an iPhone 17, with smaller models for older hardware.
Bigger models — Qwen3 4B/8B and function-call-tuned options (xLAM-2-3B,
Hermes-3-Llama-3.2-3B) — run on a paired desktop and reach the phone through
delegation. One local model is loaded at a time (RAM). Whisper handles STT.

**Optimizations for a small window.** Three layers keep tiny models viable:
the **funnel** (most requests cost 0–1 inferences), a **hardware-aware context
budget** (`ContextBuilder` assembles identity → instructions → skill → memory →
knowledge and trims to a token budget sized from `ctx_size`), and **tool-output
compression** (`compressToolResult`, a dependency-free on-device crusher that
dedupes/elides bulky tool results before they re-enter history, and never
regresses). Follow-ups: cross-turn KV/prompt-cache reuse, retrieval-gated tool
exposure (inject only relevant tool schemas), dynamic context sizing, and
fine-tuned small models that need fewer tokens per call.

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

Both consumer apps **pre-date the hackathon as wallets** and shipped with **no
AI, agent or voice features**: the desktop app was already an RGB/Lightning
trading wallet over a local RLN node, and Rate was already a multi-L2 mobile
wallet. KaleidoSwap and parts of the wallet/tooling stack are likewise prior
work.

Hackathon work is the entire intelligence layer: the shared **KaleidoMind**
engine, QVAC LLM/embedding/STT/TTS inference and P2P delegation, the tiered
funnel, recipes, skills, the on-device voice loop, safety/confirmation gates,
evidence telemetry, the evaluation harness, and the integration that gives both
pre-existing wallets their agentic and voice capabilities. Public repository
history is the audit trail for this boundary.

## Team

Walter, Arshia, Mo and Emil — KaleidoSwap, Italy / Europe.
