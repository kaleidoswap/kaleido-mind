# Changelog

All notable changes to **`@kaleidorg/mind`** (the kaleido-mind engine and its
apps) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.3] — 2026-06-21

### Fixed

- **Forced slot-extraction inference failures no longer kill a recipe the regex
  already understood.** Recipes with `forceModelExtract` (e.g. `kaleidoswap-atomic`)
  always ask the model to parse intent. On small on-device models the model can
  ramble and the inference is cancelled/times out — which surfaced as
  *"Couldn't complete that: Inference request … was cancelled"* for a plain
  "buy 1 usdt". `extractSlots` now catches an inference error and, when the
  deterministic extractor already produced valid slots, degrades gracefully to
  those instead of failing the whole request.

## [0.6.2] — 2026-06-21

### Fixed

- **`kaleidoswap-atomic` recipe was calling the maker tools with the wrong
  argument names**, so every chat swap ("buy 1 USDT") failed at the first step
  with an MCP input-validation error (`from_asset_id`/`to_asset_id`/`from_layer`/
  `to_layer`/`from_amount` all undefined). The recipe now emits the
  `kaleido-mcp ≥0.2.1` `kaleidoswap_get_quote` schema: resolves the settlement
  layer per asset (BTC→`BTC_LN`, RGB→`RGB_LN`) and puts the amount on the
  correct leg — `to_amount` for a buy ("buy 1 USDT"), `from_amount` for a
  sell/swap. `kaleidoswap_atomic_init` now reads the quote echo's `asset_id`
  and `amount_raw` (was reading the non-existent `amount`), and the confirm /
  summary render each leg from its `amount_display`. Requires `kaleido-mcp ≥0.2.1`.

## [0.6.1] — 2026-06-21

The intelligence layer goes fully on-device and gains an autonomous surface.
(`0.6.0` was an internal milestone folded into this release; it was never
tagged.)

### Added

- **QVAC on-device inference** for LLM, embeddings, speech-to-text (Whisper) and
  text-to-speech via `@qvac/sdk`, exposed through the `@kaleidorg/mind/qvac`
  subpath, with explicit P2P delegation to a paired user-controlled desktop.
- **Hands-free voice loop** (`runVoiceAssistant`): transcribe → reason → speak,
  mic-gated during playback, with a spoken confirm readback before any spend.
- **Autonomous agent** primitives: task store, scheduler, run log and risk
  gating (`autonomy/`) so the engine can run without a human in every loop.
- **On-device tool-output compression** (`compressToolResult`) for tiny context
  windows — dependency-free, no network, dedupes/elides bulky tool results and
  never regresses.
- **Flashnet swaps** as a deterministic recipe (Spark-native AMM).
- **Product Evaluation v3** harness and the timestamped `submission:evidence`
  pipeline, plus the hackathon submission docs.
- The model's `<think>` reasoning is surfaced in the chat response.

### Changed

- Replaced the synthetic benchmark with the production-funnel product
  evaluation.
- Layer/venue taxonomy clarified — Spark vs RLN/RGB, Flashnet vs KaleidoSwap —
  and swap recipes were venue-split so KaleidoSwap no longer monopolizes "swap".

### Fixed

- Spark balance/address routing through the Tier-0 fast path, Spark-native token
  balances, and the identity vs deposit-address vs invoice split.
- Skill tool allowlists aligned with real MCP names; dropped greedy bare-verb
  triggers that stole swap/commerce intents.
- "buy N USDT" routes to an atomic swap (not channel onboarding); atomic
  whitelist step uses the real `rln_atomic_taker` tool.
- Provider reliability and payment safety; `kaleido-mcp` spawned with
  `process.execPath`.

## [0.5.0] — 2026-06-16

KaleidoSwap trading and LSP onboarding land in the agent: the model can now
quote against the live maker, run atomic swaps, and buy Lightning channels —
each as a single confirm-gated recipe that stays reliable on a 0.6B model.

### Added

- **LSPS1 channel orders** — `kaleidoswap-channel-order` recipe to buy inbound
  BTC liquidity, or a new RGB asset channel pre-loaded with USDT/XAUT, from the
  maker LSP. One confirmation gate over the full chain
  (`lsp_get_info` → `lsp_estimate_fees` → `rln_get_node_info` →
  `lsp_create_order` → `rln_pay_invoice` → `rln_list_channels`).
- **Asset-channel onboarding** — `buy-asset-channel` recipe: *"buy 100 USDT"*
  onboards a channel-less user end to end via
  `kaleidoswap_lsp_quote_asset_channel` / `kaleidoswap_lsp_create_asset_channel`,
  with a rich cost confirmation.
- **Atomic swaps** — RGB ↔ BTC end to end through the recipe + Funnel;
  *"buy/sell N <asset>"* auto-quotes against the maker.
- **RGB Lightning Node skill** + taker-side `rln_*` tools, including
  `rln_list_channels` (capacity + channel status).
- **One quote tool** — `kaleidoswap_get_quote` everywhere, plus a price recipe so
  price questions return a quote instead of triggering a swap.
- **RAG auto-injection** in the Funnel's agentic tier, backed by a Bitcoin-copilot
  and channel-semantics knowledge corpus.

### Changed

- **Merchant-finder / BTC Map** is now model-driven (location discovery is less
  deterministic), the offline fallback was removed, and `SKILL.md` instructions
  were tightened to prevent malformed tool calls.
- Atomic-swap and channel-order **slot extraction is routed through the model**
  (`forceModelExtract`) with deterministic fallbacks and precision safeguards.
- User-natural amounts are scaled to maker smallest-units at the host.
- Docs (ARCHITECTURE, ROADMAP, README, SUBMISSION, skills) refreshed to the
  implemented hybrid model-driven design.

### Fixed

- Recipes skip explanatory/educational questions and route them to the agentic
  RAG path instead of firing a swap or order.
- Tool names no longer leak into user-facing replies (wallet + merchant
  instructions).
- `access_token` is threaded through `lsp_get_order` / `get_order_status` so
  order-status polling works.
- The deterministic channel-order extractor is more robust on ambiguous
  phrasings (e.g. *"on the other side"*).

## [0.4.0] — 2026-06-15

### Added

- **`@kaleidorg/mind/qvac` adapter subpath** — all `@qvac/sdk` logic lives behind
  a published subpath of core; the SDK is injected and type-only, so consumers
  pick their own runtime.
- **Delegation firewall** plus the provider, voice, voice-assistant, and
  hands-free surfaces.

> Published to npm as `@kaleidorg/mind@0.4.0`; this release was not git-tagged.

## [0.3.0] — 2026-06-14

### Added

- Initial tagged release: the engine, the per-layer wallet tool contract, the
  Recipe engine + tiered funnel (fast-path → recipe → agentic), Agent-Skills
  playbooks, memory + RAG, and the three-track eval harness (capability /
  planning / safety).

[0.5.0]: https://github.com/kaleidoswap/kaleido-mind/releases/tag/v0.5.0
[0.4.0]: https://github.com/kaleidoswap/kaleido-mind/releases/tag/v0.4.0
[0.3.0]: https://github.com/kaleidoswap/kaleido-mind/releases/tag/v0.3.0
