# Changelog

All notable changes to **`@kaleidorg/mind`** (the kaleido-mind engine and its
apps) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `TurnInput.toolChoice` (`'auto' | 'none' | 'required' | <tool name>`) and
  `TurnOutput.toolErrors`. The QVAC provider sends them as
  `generationParams.tool_choice` and reads `final.toolErrors` (`@qvac/sdk`
  0.20+).
- `AgenticOptions.firstTurnToolChoice`. The funnel sets it to `'required'`
  when the request is a wallet action (`wantsToolCall`), so the first model
  call must be a tool call. "How/what/why…" questions are not forced.
- Asset issuance (`issue-asset`) is a detected wallet action: with no
  `*issue_asset` tool in scope the funnel refuses without calling the model.

- `fixSatsBtcConversions` / `formatSatsAsBtc`: the Engine recomputes a BTC
  figure paired with a sats amount in the final answer ("4,277 sats
  (42.77 BTC)" → "4,277 sats (0.00004277 BTC)").
  `EngineOptions.fixAmountConversions` (default on). Under the same switch,
  RGB asset results reach the model with a `balance_display` ("1,000 USDT",
  scaled by `precision`), and an answer that calls an asset balance sats is
  relabelled (`annotateRgbBalances`, `fixRgbBalanceUnits`,
  `formatRgbAmount`).
- `@kaleidorg/mind/openai`: `createOpenAICompatibleProvider` runs the engine
  on any OpenAI Chat Completions server with tool calling (Ollama, LM Studio,
  llama.cpp, vLLM, hosted APIs). Streaming, `tool_choice`, `toolErrors` for
  arguments that are not valid JSON, abort on `signal`; no dependencies.
- `@kaleidorg/create-mind` 0.1.0: `npm create @kaleidorg/mind my-agent`
  scaffolds a standalone copy of `examples/rgb-agent`, generated from the
  example at pack time. CI scaffolds it, installs it with npm against the
  commit's `@kaleidorg/mind`, typechecks it and runs it offline.
- `examples/rgb-agent`: `OPENAI_BASE_URL` / `OPENAI_MODEL` / `OPENAI_API_KEY`
  switch the model to an OpenAI-compatible server.
- `examples/rgb-agent`: `pnpm eval` / `pnpm eval:mock` run seven wallet
  requests through the Funnel with a local model and check each result.

### Changed

- A turn whose tool call did not parse is sent back to the model once with the
  parse error (or, when the output hit the token cap, a "one call at a time"
  hint); if it fails again the run ends with a fixed message instead of
  showing the broken frame. The retry does not count against `maxTurns`.
- The answer guards (ungrounded payment data, amount fixes) only check text
  the model wrote, not the engine's own fixed replies. A declined send whose
  readback shortens the invoice was replaced by the "won't make one up"
  refusal.
- `runAgentic` never returns an empty answer: a run whose last turn produced
  no text ends with the "had to stop" message.
- Recipe slot extraction forces the extraction tool (`toolChoice`).
- `maxThinkingTokens` is sent as the SDK's `reasoning_budget`; the
  cancel-on-overrun check stays as a backstop with headroom. A budget at or
  above the output cap is lowered to half of it, since the model could
  otherwise spend the whole turn reasoning. Qwen3.5 ignores `/no_think`; the
  budget is what limits its reasoning.
- The `rgb-agent` and `node-minimal` examples cap reasoning at 128 tokens.

## [0.8.0] — 2026-10-07

Core `@kaleidorg/mind` 0.8.0 and `@kaleidorg/mind-provider` 0.8.0.

### Added

- **Qwen3.5 model list** in `@kaleidorg/mind/qvac`: `QWEN35_MODELS` (Qwen3.5
  0.8B / 2B / 4B / 9B and Qwen3.6 35B-A3B MoE, Q4_K_M, with exact sizes, RAM
  hints and the matching `@qvac/sdk` constant names), `DEFAULT_MODEL_ID` and
  `DEFAULT_SMALL_DEVICE_MODEL_ID` (both Qwen3.5 2B), `DEFAULT_QVAC_MODEL`,
  `DEFAULT_SMALL_DEVICE_QVAC_MODEL` and `getRecommendedModel`.
- **Agent guards** (`validateToolArgs`, `findUngroundedPaymentData`,
  `detectWalletAction`, `hasCapableTool`, `DECLINED_TOOL_MESSAGE`):
  - Tool arguments are validated against the tool's JSON Schema / Zod schema
    (plus conditional rules for `rln_issue_asset`) before `onConfirm`. Invalid
    calls return a tool error to the model; the user is not asked.
    `onConfirm` now receives the validated (coerced) arguments and a
    `summary` readback.
  - A repeated identical tool call in one run is answered from the earlier
    result instead of re-running; a third repeat forces a tool-less answer.
    A confirm-gated call resets this cache.
  - A final answer that contains an invoice, offer, LNURL, address or RGB
    invoice that no tool returned and the user never typed is replaced with a
    refusal (`EngineOptions.guardUngroundedPaymentData`, default on).
  - `Engine.composeSkill(skills, query, base)` (and `selectAvailableSkill`,
    `skillAvailable`) pick a skill that can act with the engine's tools:
    skills whose `requires-tools` frontmatter is not fully live are skipped,
    skills with at least one live tool are preferred. The funnel uses the same
    selection.
  - A wallet action (invoice, address, pay, send) that no exposed tool can
    perform gets a fixed "I can't do that here" reply without inference
    (`EngineOptions.guardMissingTools`, default on; funnel `route: 'no-tool'`).
  - When the user declines every call in a turn the run ends with a fixed
    "Cancelled — you declined: … Nothing was sent or changed." reply
    (`EngineOptions.endTurnOnDecline`, default on).
  - An empty answer after tool calls (e.g. reasoning used the whole output
    budget) triggers one tool-less retry, then falls back to the last tool
    result. `TurnOutput.incomplete` marks such turns; the QVAC provider sets
    it.
- Text tool-call recovery understands Qwen3.5's XML call format
  (`<function=…><parameter=…>`).
- Provider: catalog entries carry `recommended` (the 2B default) and
  `tool_confirm_request` carries the optional `summary` readback.

### Added

- **Submarine swaps on the KaleidoSwap /v2 maker** (kaleidoswap-maker-rs): pay a
  Lightning invoice from Liquid funds.
  - New contract `SUBMARINE_TOOLS` (`kaleidoswap_submarine_pairs`, `_create`,
    `_fund`, `_status`, the same names kaleido-mcp implements) with
    `bindSubmarineTools`. Only `_fund` is a spend, and it takes nothing but the
    swap id.
  - `submarinePayRecipe` (opt-in, register before `paymentsRecipe`): "pay <invoice>
    with L-USDT" / "paga <invoice> con USDT su Liquid" → create → one
    confirmation showing the maker's exact amount → fund. A bare "USDT" stays
    RGB USDT and is not matched.
  - `MockWallet` simulates the /v2 maker (Liquid balances, 0.5% fee, BOLT11
    amount parsing), and a new `submarine-swaps` skill covers the flow.
### Fixed

- **`issueAssetRecipe` slot extraction.** Issuance is irreversible, so these
  matter even behind the confirm gate:
  - "1.000" / "1,000" are read as one thousand (was 1); "1,5k" is 1500.
  - The supply is never taken from a number inside the asset name
    ("Web3 Summit 2026, supply 300" → 300). Without a clear supply, the recipe
    is not confident and falls back to the model.
  - The recipe fires only when the request opens with the verb, so "I have an
    issue with my tokens" or "how do I create a token?" reach the model.
  - Apostrophes in names ("Joe's Pizza", "dell'Arte") are no longer read as
    quotes.
- `MockWallet.reset()` restores the full initial state (balances, contacts,
  UTXOs, issued assets), not only the send/transfer history.
- CLI `rln_issue_asset` no longer defaults a missing `amount` to 1; it rejects
  any amount that isn't a positive safe integer after `precision` scaling.

### Changed

- **Model catalog moved to Qwen3.5.** The provider and CLI catalogs, examples
  and quickstarts now use Qwen3.5 2B by default: on an M4 it passed all 7 signet
  RGB wallet tasks at 45–150 s per question; 4B was equally correct but about
  twice as slow, 9B slower still, and 0.8B loops on actions.
  Qwen3 (0.6B–30B-A3B) and Hermes 3 are removed: they garbled multi-argument
  wallet calls such as `rln_issue_asset`. Previously downloaded GGUFs no longer
  appear as installed catalog models; add them back by Hugging Face URL if
  needed. The Qwen3.5 constants exist in every supported `@qvac/sdk` (0.13.1+),
  so peer ranges are unchanged.
- **Declines are attributed to the user.** A declined call returns
  `{ status: 'cancelled_by_user', declined_by: 'user', tool, message }` (plus
  `host_reason` when the host gave one) instead of
  `{ declined: true, reason: 'user declined' }`.
- Provider defaults: `KALEIDO_MIND_MAX_THINKING_TOKENS` 128 → 512 and
  `KALEIDO_MIND_MAX_TOKENS` 512 → 1536. Qwen3.5 2B used 80–390 thinking tokens
  per wallet turn; the old caps cut turns off before a tool call or answer.
- RGB invoices are only treated as payment data when they carry a path or
  beneficiary; plain `rgb:` asset ids never trip the payment-data guard.
- `confirmReadback` never prints `NaN`: missing or non-numeric amounts read as
  "an unspecified amount", and stray quotes/commas are trimmed from tickers.
- `rgb-lightning-node` skill 0.3.3: `rln_list_assets` documents its optional
  `schemas` filter and says to call it once; tickers must be resolved to an
  `asset_id` via `rln_list_assets` before invoices, balances and sends; LN
  invoices must come from the tool. `spark-wallet` declares
  `requires-tools: spark_get_balance`.

- **RGB issuance tools aligned with kaleido-mcp**, which now ships them as
  `wdk_*` / `rln_*`: `rln_list_transfers` takes `asset_id` (in-app wallets still
  accept a ticker), `rln_create_utxos` adds optional `size`, `up_to` and
  `fee_rate`, and `rln_issue_asset` adds `details` and only requires `name`
  (`ticker` for NIA/UDA and `amount` for NIA/CFA are checked by the tool).
  The `rgb-lightning-node` skill documents the shared schemas and gains an
  "issue your own RGB asset" recipe.

### Removed

- **KaleidoSwap order flow.** The maker no longer offers order-based swaps
  (kaleido-sdk 0.1.12 dropped them), so `kaleidoswap_place_order`,
  `kaleidoswap_get_order_status` and `kaleidoswap_get_order_history` are gone
  from the KaleidoSwap contract, together with its `orders` group, the CLI and
  playground maker routes, the `kaleido-trading` skill, evals and docs. Swaps
  run through the atomic flow (`kaleidoswap_get_quote` →
  `kaleidoswap_atomic_init` → `rln_atomic_taker` →
  `kaleidoswap_atomic_execute` → `kaleidoswap_atomic_status`). Hosts that bound
  handlers for the order tools or passed `groups: ['orders']` must move to the
  atomic tools.

### Fixed

- **CLI chat no longer throws at startup** binding the KaleidoSwap contract:
  the CLI has no maker route for `kaleidoswap_lsp_quote_asset_channel` /
  `kaleidoswap_lsp_create_asset_channel`, so it now binds with
  `allowMissing: true` like its other tool sources.

## [0.7.0] — 2026-10-06

Core `@kaleidorg/mind` 0.7.0 and `@kaleidorg/mind-provider` 0.7.0.

### Added

- **Package README** with install, a five-minute QVAC quickstart, subpath
  exports, the wallet tool contract, MCP wiring and how to write tools and
  skills.
- **`examples/node-minimal`** (Engine + QVAC + one in-process tool and skill)
  and **`examples/rgb-agent`** (a local model driving an RGB Lightning Node via
  kaleido-mcp on signet, with a mock mode that needs no node). Both are
  typechecked in CI; the rgb-agent offline mode runs in CI too.
- **RLN contract aligned with kaleido-mcp.** New `rln_*` tools with
  kaleido-mcp's argument names: `rln_get_asset_balance`,
  `rln_refresh_transfers`, `rln_get_address`, `rln_send_btc` 🔒,
  `rln_list_payments`, `rln_connect_peer`, `rln_open_channel` 🔒,
  `rln_close_channel` 🔒, `rln_get_channel_id`, `rln_atomic_taker` 🔒,
  `rln_list_swaps`, `rln_get_swap`. `confirmReadback` speaks the new spend
  tools and kaleido-mcp's `asset_id` / `recipient_id` for `rln_send_asset`.
  Existing tool schemas are unchanged.
- **Claude Code plugin + marketplace** (`.claude-plugin/`): installs the
  bundled skills and starts kaleido-mcp on signet
  (`/plugin marketplace add kaleidoswap/kaleido-mind`).
- **`kaleido-node` skill**: node lifecycle (start/stop, init, unlock,
  recovery) over kaleido-mcp's `kaleido_node_*` tools or the `kaleido` CLI,
  with password and mnemonic safety rules.
- `kaleido-trading` 0.5.0 gains `references/` (atomic flow over kaleido-mcp,
  assets/units/precision, maker API) and the kaleido-mcp atomic-only path;
  `paid-data` 0.2.0 covers the MPP three-step flow and paid-API discovery;
  `rgb-lightning-node` 0.3.1 explains RGB balance fields.
- **`toQvacTools`** (`@kaleidorg/mind/qvac`) — maps engine tools to the
  `completion({ tools })` shape.
- **`@kaleidorg/mind/testing`** — a new subpath export so hosts can build and
  demo an agent with no node, no funds and no model. `MockWallet` (moved from
  the CLI eval, unchanged behaviour for the existing tools) binds the canonical
  wallet contract to stateful fakes; `scriptedProvider` replays planned turns
  in place of a QVAC model. The eval imports the same class, so the safety and
  product benchmarks are unaffected.
- **RGB issuance in the wallet contract.** New `rln_*` tools:
  `rln_issue_asset` (NIA / CFA / UDA, 🔒), `rln_create_utxos` (🔒),
  `rln_list_assets`, `rln_list_transfers`. `confirmReadback` speaks issuance
  ("Issue 1,000 TICKET (Hackathon Ticket), a new RGB asset. Confirm?").
  `MockWallet` models issuance, colored-UTXO exhaustion and per-asset transfers.
- **`issueAssetRecipe`** (opt-in, register via `Funnel.recipes`): "issue 1000
  TICKET tokens called Hackathon Ticket", "mint an NFT called Genesis Badge",
  "crea 500 token CAFE chiamati Caffè Club" → one confirmation-gated
  `rln_issue_asset` with zero inferences. Registered in the CLI chat, whose RLN
  tool source now also routes `rln_issue_asset`, `rln_create_utxos` and
  `rln_list_transfers` to a real node.
- `rgb-lightning-node` skill 0.2.0 documents the issuance tools with few-shot
  examples.

### Changed

- `rgb-lightning-node` skill 0.3.0: documents every declared tool, drops the
  non-existent `rln_whitelist_swap` (use `rln_atomic_taker`), and notes where
  in-app and kaleido-mcp argument names differ.
- `@qvac/sdk` optional peer range is `>=0.13.1` (core) / `>=0.13.5`
  (provider); developed and tested against 0.21.0. P2P delegation needs
  0.13–0.18: QVAC 0.19 removed `startQVACProvider` and `loadModel({ delegate })`.
- Development dependencies: `@qvac/sdk` 0.21.0, `@modelcontextprotocol/sdk`
  1.32.1 (provider, examples), vitest 5; `packageManager` is pnpm 9.15.9.

### Fixed

- **Tool arguments reached QVAC models empty.** The provider sent JSON-Schema
  tools without `type: 'function'`, so the SDK treated them as Zod inputs and
  dropped every parameter. JSON-Schema tools are now normalised to the SDK's
  `Tool` shape (affects every contract and MCP tool on 0.13 and 0.21).
- **Cancelled turns threw instead of returning.** Since QVAC 0.11 a cancelled
  run rejects `final` with `InferenceCancelledError`; `consumeRun` now folds it
  into a `stopReason: 'cancelled'` turn, so a stop button and the thinking-token
  budget end the turn cleanly (the budget fallback text is shown again).
- Per-turn `completionTokens` / `totalTokens` are derived from the SDK's
  `generatedTokens` stat.
- Provider sidecar: with an SDK that has no P2P provider it now reports that
  and runs desktop-only instead of failing after a misleading 60 s timeout.

## [0.6.4] — 2026-06-21

### Added

- **Stop / cancel an in-flight chat turn.** A new `signal?: AbortSignal` on
  `FunnelCallbacks` is threaded into both the agentic loop and the recipe chain
  (slot extraction + every step). The QVAC provider's `runTurn` now honors the
  signal — when it aborts, the running model inference is cancelled via the
  SDK's `cancel({ requestId })`, so a single abort stops the inference *and*
  halts the loop/chain at its next checkpoint. A recipe cancelled this way
  reports `status:'cancelled'` ("Stopped.") and runs no further steps — an
  explicit stop never silently falls back to deterministic slots. The
  `@kaleidorg/mind-provider` sidecar exposes this as a `cancel_chat` command
  (see provider 0.6.3).

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
