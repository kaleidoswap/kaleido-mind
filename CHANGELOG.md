# Changelog

All notable changes to **`@kaleidorg/mind`** (the kaleido-mind engine and its
apps) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.10] — 2026-10-08

One Lightning payment is capped at about 10% of the channel's capacity (the
LSP's in-flight HTLC limit, `next_outbound_htlc_limit_msat`; 5,400 sats on a
54,000-sat channel on signet), so a BTC → asset swap of X sats needs a channel
of at least 10 × (X + 3,000).

### Fixed

- Swap channel check: when the balance is enough but one payment is capped, it
  says so and names the capacity needed, instead of suggesting more balance.
- `channel-manager` / `references/lsp.md`: channels for swaps are sized by
  capacity too (≥ 10 × (swap + 3,000)); the "channel to swap" example no
  longer uses a 4,000-sat balance that fits no swap. `kaleido-trading` checks
  `next_outbound_htlc_limit_msat`, not the balance.

## [0.10.9] — 2026-10-08

### Fixed

- The swap recipe follows the swap to the end: it keeps the `access_token`
  that only `kaleidoswap_atomic_init` returns and polls
  `kaleidoswap_atomic_status` until `Succeeded`, `Expired` or `Failed` (90 s),
  then says whether the swap completed. Without the token the maker answered
  "Swap not found". If it isn't final by then, the reply gives the call to
  check it later. Hosts without the status tool skip the polling.
- BTC amounts in swap confirmations and summaries read in sats from the raw
  msat amount ("2,500 sats", not "0.000025 BTC"), in the recipe and in the
  readbacks.
- The swap channel check skips the asset-channel part when the quote names the
  asset by ticker instead of its `rgb:` id, instead of reporting no channel.

### Added

- `Recipe.poll`: after the final action, call a tool until `done(result)` or a
  timeout. `RunRecipeOptions.pollIntervalMs` / `pollTimeoutMs` override them.

## [0.10.8] — 2026-10-08

`@kaleidorg/mind` 0.10.8, `@kaleidorg/create-mind` 0.3.4.

### Fixed

- Swap recipe units: `kaleidoswap_get_quote` takes display units, but the
  recipe passed a BTC amount said in sats as is ("swap 2500 sats" → 2,500
  BTC on kaleido-mcp hosts). It converts now (`quoteAmount`: sats → BTC; an
  amount said in BTC is kept; without a unit, < 1 is BTC and ≥ 1 is sats).
- "Swap 2500 sats into USDT" no longer reaches the model: an explicit
  "swap / convert / exchange / trade / sell <N> <asset> for|to|into <asset>"
  uses the deterministic extraction (`Recipe.trustExtract`). Qwen3.5 2B read
  it as 2,500 USDT and gave up after 170 s. Checked against a signet node
  through kaleido-mcp 0.4.3: recipe route, no model call, real quote, and the
  channel check stops it before the confirmation.
- Accepting an atomic swap (`rln_atomic_taker`, `wdk_atomic_taker`) is read
  back with the run's quote amounts ("you send 2,500 sats, you receive
  1.5 USDT"), flags a swapstring that isn't the swap just created, and decodes
  the swapstring when there is no quote. `confirmReadback` takes an optional
  context with earlier results.
- `kaleidoswap_atomic_init` is read back with the quote's amounts and expiry
  ("Swap 2,500 sats for 2.020975 USDT on KaleidoSwap (quote expires in 45s)"),
  flags amounts that differ from the quote, and shows the raw amounts when
  there is no quote; `kaleidoswap_atomic_execute` with the quote's amounts.
  Before, both read "Run kaleidoswap_atomic_init?".
- Swap channel check: when the outbound only covers the HTLC minimum, the
  message says no BTC swap fits instead of "swap at most 0 sats".

### Changed

- rgb-agent example and the `create-mind` starter run through the Funnel
  (`createFunnel` in `setup.ts`: fast path, swap/price/send/receive recipes,
  skills), the same pipeline as the apps, and expose the RGB node and trading
  skills' tools. The eval exposes the atomic swap tools.

## [0.10.7] — 2026-10-08

### Fixed

- The swap recipe's channel check covers both directions and both legs, with
  the same rules as kaleido-mcp 0.4.3's `atomic_init` preflight. BTC → asset:
  BTC outbound ≥ amount + HTLC minimum, and an asset channel with inbound for
  the asset and BTC inbound ≥ minimum. Asset → BTC: an asset channel holding
  the asset with BTC outbound ≥ minimum, and BTC inbound ≥ amount + minimum.
  The minimum is the node's `rgb_htlc_min_msat` (fallback 3,000,000 msat);
  `rln_get_node_info` now runs before the check. Unreadable channel data
  doesn't block. `swapLiquidityShortfall` (`outboundShortfall` is an alias).
- `kaleido-trading` states the rule for both directions.

## [0.10.6] — 2026-10-08

A BTC → RGB swap over Lightning sends the amount plus RLN's 3,000-sat HTLC
minimum in one payment, so a channel needs outbound of at least amount +
3,000 sats. With the smallest LSP channel (4,000 `client_balance_sat`, about
3,000 outbound) no swap fits, and the swap failed with NoRoute after the maker
had locked it.

### Fixed

- `kaleidoswap-atomic` recipe: when the taker pays in BTC over Lightning, it
  reads `rln_list_channels` after the quote and stops before the confirmation
  if no usable channel can send amount + 3,000 sats, saying how much it can
  swap instead (`outboundShortfall`, `RLN_HTLC_MIN_MSAT`).
- Skills: `kaleido-trading` checks outbound ≥ amount + 3,000 sats before a
  BTC → asset swap; `channel-manager` and `references/lsp.md` buy channels
  with `client_balance_sat` ≥ the largest planned swap + 6,000 (the old "at
  least 4,000" left no room for a swap).

### Added

- Recipe steps can be `optional` (a missing or failing tool doesn't stop the
  recipe) and have a `check(ctx)` that stops the recipe with a message before
  any later confirmation or spend.

## [mind-provider 0.10.1] — 2026-10-07

### Added

- `complete` command: inference on the loaded model for another client (the
  desktop serving a phone). Takes `messages`, optional `tools` (schemas only),
  `toolChoice`, `maxTokens`, `temperature`; streams `completion_delta`;
  returns `{ text, rawContent, toolCalls, toolErrors?, inference? }`. Tools are
  never executed, no agent prompt, skills or memory are added, chat history is
  untouched, and no `chat_*` / `tool_confirm_*` / thinking events are emitted.
  Fails with `QVAC model not loaded` without a model. `cancel_completion`
  aborts one by id.
- Model calls from chat, scheduled tasks and `complete` run one at a time on
  the shared model handle (per call, so a chat waiting on a confirmation does
  not block other clients).

## [0.10.5] — 2026-10-07

`@kaleidorg/mind` 0.10.5, `@kaleidorg/create-mind` 0.3.3.

### Changed

- `kaleido-trading`: a Lightning swap needs a channel; when there is none,
  buy one first. `channel-manager` and its new `references/lsp.md` carry the
  LSP purchase flow verified on a signet RLN node with kaleido-mcp 0.4.2
  (pay `amount_due_sat`, never `fee_sat`; `lsp_get_order` takes the order's
  `access_token`). kaleido-mcp tool snapshot refreshed to 0.4.2.
- Confirmation readbacks for `lsp_create_order`,
  `kaleidoswap_lsp_create_order` and `kaleidoswap_lsp_create_asset_channel`
  say what is ordered and that the order total is paid in a separate,
  separately confirmed step.

### Added

- rgb-agent eval: `buy-channel` scenario.

## [0.10.4] — 2026-10-07

### Fixed

- `kaleidoswap_lsp_create_order` from kaleido-mcp is confirmation-gated, like
  the in-app `lsp_create_order`. The kaleidoswap_ prefix kept it out of the
  LSPS1 spend list, so an MCP host created a paid channel order without asking.

## [0.10.3] — 2026-10-07

`@kaleidorg/mind` 0.10.3, `@kaleidorg/create-mind` 0.3.2.

### Fixed

- Starter and rgb-agent example against a real node: the kaleido-mcp allow
  list left out `rln_get_node_info`, which `rgb-lightning-node` requires, so
  the skill was never selected and the invoice step looped. The allow list is
  now derived from the skill (`skillToolNames`). Checked against a signet RLN
  node with kaleido-mcp 0.4.1: both requests select `rgb-lightning-node`.
- The example's confirmation prompt declines instead of hanging when stdin is
  not a terminal.

### Added

- `skillToolNames(skill)`: a skill's `requires-tools` plus its scoped tools.

## [0.10.2] — 2026-10-07

### Changed

- `rgb-lightning-node` skill: send and RGB invoice take the ticker (`USDT`) or
  the `asset_id`; the worked examples pass the ticker. The engine and
  kaleido-mcp 0.4.1 both resolve tickers, so the model no longer needs a
  `rln_list_assets` lookup first. rgb-agent eval (`REPEAT=3`): send 2/3 → 3/3
  on Qwen3.5 2B and 0/3 → 3/3 on Gemma4 2B, each in a single call.
- kaleido-mcp tool snapshot refreshed to 0.4.1.

## [0.10.1] — 2026-10-07

Robustness on models other than Qwen. rgb-agent eval (fake RLN node):
Gemma4 2B 5/6 (rgb-invoice now passes), Llama 3.2 tool-calling 1B 3/6 (was
2/6, with every agentic turn failing).

### Fixed

- Invoices and addresses that receive tools return are shown verbatim. If
  the answer leaves them out they are appended; if it carries a partial or
  garbled copy, the answer is built from the tool's value instead of the
  "won't make one up" refusal (`producedPaymentData`, `producedPaymentReply`,
  `paymentStrings`).
- QVAC provider: "tool_choice demanded a tool call, but the chat template did
  not render the tool definitions" is retried once without `tool_choice`
  instead of failing the request.
- Text tool-call recovery accepts a reply that is only a call in the skills'
  example notation, `` `tool_name {"arg": 1}` ``.
- A `*_send_asset` / `*_create_rgb_invoice` call that passes a ticker
  (`USDT`) as `asset_id` / `asset` is resolved to the asset id with the same
  host's `*_list_assets` before validation, on in-app and kaleido-mcp hosts.

### Added

- rgb-agent eval: `REPEAT=n` runs each scenario n times and prints the pass
  rate per scenario. `@kaleidorg/create-mind` 0.3.1 ships it.

## [0.10.0] — 2026-10-07

`@kaleidorg/mind` 0.10.0, `@kaleidorg/mind-provider` 0.10.0,
`@kaleidorg/create-mind` 0.3.0.

### Changed

- Skills 15 → 12, about 24k → 6k tokens in total: `liquidity-optimizer` and
  `kaleido-lsps` merge into `channel-manager`, `dca` into `portfolio-manager`.
  Every skill follows one short template: a one-line description, exact
  `tools` and `requires-tools`, a short Do list and worked examples with
  kaleido-mcp's argument names and units. Skills that need an in-app tool are
  not selected on kaleido-mcp hosts. Long material moves to `references/`.
  With the rgb-agent eval the agentic prompt drops from ~5,200 to ~2,800
  tokens.
- Contracts take kaleido-mcp's argument names and units:
  `kaleidoswap_get_quote` takes `from_asset_id` / `to_asset_id` and
  `from_amount` or `to_amount` in display units; atomic init / execute /
  status take the quote's `rfq_id`, raw amounts, `swapstring` and
  `payment_hash`; `rln_send_asset` and `rln_create_rgb_invoice` take
  `asset_id` / `recipient_id`; `get_price` takes `vs_currency`. The binders
  fill the previous names for existing handlers (`normalizeWalletArgs`,
  `normalizeKaleidoswapArgs`). A quote with a BTC amount of 1000 or more is
  rejected as sats passed as BTC.

### Added

- `catalog.test.ts`: every skill's tools exist in the in-app contracts or the
  vendored kaleido-mcp snapshot (`scripts/snapshot-mcp-tools.mjs`), shared
  tools take the same arguments, worked examples are valid calls, prompts
  select the expected skill. `skills/README.md` explains how to write a skill.
- `MockWallet` implements `rln_get_node_info`, so skills that require it are
  selected on the fake node.

### Fixed

- QVAC provider: a turn that fails with "Unexpected empty grammar stack after
  accepting piece: </think>" (the tool grammar rejecting the `</think>`
  llama.cpp inserts when the reasoning budget runs out) is retried once with
  reasoning off instead of failing the request.

## [0.9.0] — 2026-10-07

Requires `@qvac/sdk` 0.20 or later. `@kaleidorg/mind` 0.9.0,
`@kaleidorg/mind-provider` 0.9.0, `@kaleidorg/create-mind` 0.2.0.

### Removed

- P2P delegated inference: `allowListFirewall`, `denyListFirewall`,
  `firewallFromKeyList`, `buildDelegateConfig` and their types are gone from
  `@kaleidorg/mind/qvac`. `@qvac/sdk` 0.19 removed the provider API they
  configured. To run the model on another machine, use an OpenAI-compatible
  server with `@kaleidorg/mind/openai`.
- Provider app: no P2P bootstrap and no Whisper/TTS models for paired phones.
  The status snapshot still carries `publicKey`, `sttReady` and `ttsReady`
  (always `null`/`false`) for protocol compatibility.
- QVAC provider: the cancel-at-cap thinking backstop and its fallback message.
  `reasoning_budget` bounds reasoning and the output cap bounds the turn.

### Changed

- Peer dependency `@qvac/sdk >= 0.20.0` (was `>= 0.13.1`); the provider sends
  `tool_choice` and `reasoning_budget`, which older SDKs reject or ignore.
- `capabilityProfile({ delegated })` → `capabilityProfile({ remote })`;
  evidence `model.source` `'delegated'` → `'remote'`.
- Engine internals: run state in one object, `callModel` / `executeCall`
  extracted, and `engine/answer.ts` holds the fixed replies and
  `finalizeAnswer`, the single place that decides what reaches the user.
  Behaviour unchanged.

### Fixed

- `create-mind` 0.1.1 and the 0.8.1 rgb-agent example turned the experimental
  session cache on by default. It is off now (`SESSION_CACHE=1` to try it): with
  it on, Qwen3.5 2B copied a Lightning invoice correctly in 4/10 eval runs vs
  10/10 without.

### Added

- Subpath exports for the domain packs: `@kaleidorg/mind/kaleidoswap`,
  `/lsps1`, `/submarine`, `/bitrefill`, `/flashnet`, `/knowledge`. The root
  still re-exports them; 1.0 drops those re-exports.

## [0.8.1] — 2026-10-07

Faster requests on small local models. Measured with the rgb-agent eval
(Qwen3.5 2B, fake RLN node): balance and asset list 25–110 s → instant;
issue, invoices and send 60–130 s → 11–19 s.

### Added

- Fast path on RLN tools: each fast-path intent has `fallbackTools`, so the
  balance intent uses `rln_get_balances` / `wdk_get_balances` when the host has
  no aggregate `get_balances`, and the address intent `rln_get_address`. New
  `assets` intent on `rln_list_assets`. Results from the aggregate wallet,
  kaleido-mcp and `MockWallet` are rendered without a model.
- `TurnInput.thinking: 'off'`; the QVAC provider sends `reasoning_budget: 0`.
  The Engine turns reasoning off on a forced first tool call
  (`EngineOptions.thinkOnForcedCalls` keeps it on).
- `TurnInput.sessionKey` and `LLMProvider.endSession`: one key per agentic
  run. With `sessionCache: true` and the injected `deleteCache`, the QVAC
  provider passes it as `kvCache`, so calls after the first send only the new
  tool result instead of the ~5k-token prompt (time to first token ~7 s →
  ~0.2 s on Qwen3.5 2B). Experimental and off by default: with it on, the
  model copied a Lightning invoice correctly in 4/10 eval runs vs 10/10
  without. The rgb-agent example enables it with `SESSION_CACHE=1`.

## [0.8.0] — 2026-10-07

Core `@kaleidorg/mind` 0.8.0, `@kaleidorg/mind-provider` 0.8.0 and `@kaleidorg/create-mind` 0.1.0.

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
