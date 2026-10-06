# kaleido-mind

> Sovereign AI for sovereign money. A local-first, agentic financial assistant for multi-layer Bitcoin wallets. It trades, pays, onboards and finds merchants across Spark, RGB/Lightning and Arkade, by chat or voice, fully on-device.

`@kaleidorg/mind` is the reasoning and tool-calling engine behind that
assistant. It runs the same agent on a phone, a laptop or a server. Inference
goes through the [QVAC SDK](https://www.npmjs.com/package/@qvac/sdk), locally
or on a paired machine the user controls. The design starts from one
constraint: **small on-device models are slow and weak at arguments**, so they
are never asked to do the slow or weak parts.

**Start here:**
[package docs and quickstart](./packages/core/README.md) ·
[examples](./examples) ·
[architecture](./docs/ARCHITECTURE.md)

## Use it in your app

```bash
npm i @kaleidorg/mind @qvac/sdk
```

The [package README](./packages/core/README.md) covers a five-minute QVAC
quickstart, the subpath exports, the wallet tool contract, connecting MCP
servers (such as `kaleido-mcp`) and writing your own tools and skills.

## Use with Claude Code / Claude Desktop

The skills in [`packages/core/skills`](./packages/core/skills) follow the Agent
Skills format, so Claude can use them directly, together with the
[kaleido-mcp](https://www.npmjs.com/package/kaleido-mcp) server.

**Claude Code plugin.** This repository is also a plugin marketplace:

```bash
/plugin marketplace add kaleidoswap/kaleido-mind
/plugin install kaleido-mind@kaleidoswap
```

The plugin installs the skills and starts `npx -y kaleido-mcp` over stdio. The
server reads three variables from your environment:

| Variable | Default | Purpose |
|---|---|---|
| `KALEIDO_NETWORK` | `signet` | KaleidoSwap network preset (kaleido-mcp 0.3.0+) |
| `RLN_NODE_URL` | `http://localhost:3001` | your RGB Lightning Node API |
| `WDK_SEED` | empty | seed for the Spark wallet tools; leave empty to skip them |

**Plain MCP (Claude Desktop, other clients).** Add the server to
`claude_desktop_config.json` (or a project `.mcp.json`):

```json
{
  "mcpServers": {
    "kaleido": {
      "command": "npx",
      "args": ["-y", "kaleido-mcp"],
      "env": { "KALEIDO_NETWORK": "signet", "RLN_NODE_URL": "http://localhost:3001" }
    }
  }
}
```

To use the skills without the plugin, copy the skill folders you want into
`~/.claude/skills/`.

**Which skills work with kaleido-mcp alone.** `rgb-lightning-node`,
`kaleido-node`, `kaleido-trading` (atomic swaps), `kaleido-lsps`,
`channel-manager`, `liquidity-optimizer`, `dca`, `portfolio-manager` and
`paid-data` use tools that kaleido-mcp provides. The other skills call tools
that come from the `@kaleidorg/mind` runtime or from other servers:
`spark-wallet` and `wallet-assistant` use the in-app wallet contract,
`bitrefill` needs the Bitrefill MCP, `flashnet-swaps` needs Flashnet tools, and
`merchant-finder` needs a BTC Map tool. In Claude Code these skills
won't work unless you connect those tools. The `tools:` and `triggers:`
frontmatter lines are read by the mind runtime; Claude ignores them.

## Examples

| Example | What it does | Run |
|---|---|---|
| [`node-minimal`](./examples/node-minimal) | Engine + QVAC local model + one in-process tool, routed by one skill | `pnpm start` / `pnpm start:mock` |
| [`rgb-agent`](./examples/rgb-agent) | A local model operates an RGB Lightning Node through kaleido-mcp on signet: RGB balances, RGB invoice, asset send behind a confirm gate | `pnpm start` / `pnpm start:mock` / `pnpm start:offline` |

```bash
corepack enable
pnpm install && pnpm build
cd examples/node-minimal && pnpm start      # downloads Qwen3 1.7B (~1 GB) on first run
cd ../rgb-agent && pnpm start:mock          # fake RLN node, real local model
```

## How it works

1. **One tool contract, many transports.** The model sees the same tool names
   and schemas everywhere. Only execution changes: in-process wallet adapters
   on mobile, an MCP server or CLI on desktop, stateful simulators in tests.
   Skills are therefore portable and benchmarks are comparable.
2. **Recipes, not planning.** A small model can't reliably plan *"pay bob 3
   EUR"* (resolve → price → convert → confirm → send). A recipe carries the
   plan and the model only fills the slots, which takes about one inference
   instead of five. Complex recipes, such as atomic swaps, can force slot
   extraction through the model, with deterministic fallbacks.
3. **A tiered funnel.** Most requests never reach the model.

```
user request
  ├─ T0  fast-path     "balance" / "address" / "btc price"   → 0 inferences
  ├─ T2  recipe        "pay bob 3 EUR" / "buy 0.001 BTC"      → ~1 inference, deterministic chain, confirm-gated
  └─ T1  agentic loop  everything else                        → skill-scoped LLM with tools
```

**Confirm-before-spend is structural.** Every tool that moves funds is marked
`requiresConfirmation` in the contract, so the engine pauses for the host's
confirm sheet and the model can't bypass it. The sheet shows a deterministic
readback built from the resolved call, not from the model (*"Send 4,800 sats to
bob over Spark. Confirm?"*).

What else is in the box:

- **Tool sources:** in-process, MCP, CLI and L402 (pay-per-call HTTP), all
  behind one `ToolRegistry`.
- **Contracts and recipes:** a multi-L2 wallet contract (`spark_*`, `rln_*`,
  `arkade_*`, `liquid_*` and router tools), KaleidoSwap trading (quotes, atomic
  swaps) and LSPS1 channel orders, plus recipes for payments, swaps, asset
  sends, channel onboarding and RGB issuance.
- **Skills:** 14 bundled playbooks in the Agent Skills format (`SKILL.md` with
  progressive disclosure), loadable from disk or bundled for React Native.
- **Memory and RAG:** long-term recall and retrieval with injected embeddings,
  through QVAC.
- **Voice:** a hands-free STT → agent → TTS loop on QVAC Whisper and
  Supertonic.
- **Testing:** `@kaleidorg/mind/testing` provides a stateful `MockWallet` and a
  `scriptedProvider`, so the whole funnel runs in CI with no node, no funds and
  no model.

## Repository layout

```
kaleido-mind/
├── packages/core/     @kaleidorg/mind — the engine (published)
│   ├── src/           engine, funnel, contracts, recipes, skills, tools, memory, rag, qvac
│   └── skills/        bundled SKILL.md playbooks
├── apps/
│   ├── provider/      @kaleidorg/mind-provider — Node sidecar (JSON-RPC over stdio) for desktop hosts (published)
│   ├── cli/           kaleido-mind CLI — model management, chat, product and diagnostic evals
│   └── playground/    exercise the engine against a real local model
├── examples/          node-minimal, rgb-agent
├── .claude-plugin/    Claude Code plugin + marketplace manifests (skills + kaleido-mcp)
├── docs/              architecture, function calling, memory/RAG, integration, benchmark, publishing
└── submission/        QVAC hackathon submission material and evidence
```

## Apps built on it

- **[Rate](https://github.com/kaleidoswap/Rate):** a React Native mobile
  wallet. The engine runs on-device with a QVAC LLM, Whisper STT and neural
  TTS, the voice loop, recipes and the confirm gate. Wallet tools are
  in-process adapters.
- **[desktop-app](https://github.com/kaleidoswap/desktop-app):** a Tauri
  RGB/Lightning trading wallet. The provider sidecar runs the agent over a
  local RGB Lightning Node through kaleido-mcp.

## Development

```bash
corepack enable                 # uses the pinned pnpm from package.json
pnpm install --frozen-lockfile
pnpm build                      # all workspace packages
pnpm typecheck                  # includes examples/
pnpm test                       # core unit tests (no model, no network)
```

Requirements: Node 20 or newer and pnpm 9.

Workspace quirks, and why they exist:

- **`.npmrc` uses `node-linker=hoisted` and `shamefully-hoist=true`.** The QVAC
  / Bare native toolchain resolves the project root and its sibling addon
  packages by walking a flat `node_modules`. pnpm's symlinked layout breaks
  this, and `loadModel()` then fails with *"No binaries found for target"*.
- **`@qvac/sdk` is a root dependency.** `apps/cli` and `apps/playground`
  declare it as a peer, and the root install is the copy they (and local runs
  of the examples) use. Core itself only imports QVAC types.
- **`require-asset` is a root dependency.** The platform runtime
  (`bare-runtime-darwin-arm64` and similar) needs it, but pnpm does not install
  it for that optional platform package. Without the root entry,
  `import('@qvac/sdk')` crashes when the Bare worker starts. Verified against
  `@qvac/sdk` 0.21.0. Remove it only after a model loads without it.

CI (`.github/workflows/ci.yml`) builds, typechecks (packages, apps and
examples), runs the core tests and runs the `rgb-agent` example offline.
Releases are described in [docs/PUBLISHING.md](./docs/PUBLISHING.md) and
[CHANGELOG.md](./CHANGELOG.md).

## Evaluation

The headline benchmark is [Product Evaluation v3](./docs/EVALUATION_V3.md).
Realistic wallet, trading, node, discovery and safety scenarios run through the
production funnel, and each run is graded on route, arguments, confirmation
behavior, side effects and the final answer. See
[docs/BENCHMARK.md](./docs/BENCHMARK.md) for methodology and
[REPRODUCE.md](./REPRODUCE.md) for producing timestamped evidence on your own
hardware.

## Docs

- [ARCHITECTURE.md](./docs/ARCHITECTURE.md): cross-surface design and the tool contract
- [FUNCTION_CALLING.md](./docs/FUNCTION_CALLING.md): how tool calls flow through QVAC
- [INTEGRATION.md](./docs/INTEGRATION.md): embedding the engine in a host
- [MEMORY_RAG.md](./docs/MEMORY_RAG.md): memory and retrieval
- [MODEL_MANAGEMENT.md](./docs/MODEL_MANAGEMENT.md): models and hardware budgets
- [BENCHMARK.md](./docs/BENCHMARK.md) · [EVALUATION_V3.md](./docs/EVALUATION_V3.md): evaluation
- [ROADMAP.md](./docs/ROADMAP.md) · [PUBLISHING.md](./docs/PUBLISHING.md)

## QVAC Hackathon submission

kaleido-mind was first built for the QVAC Hackathon. The demo video, tracks,
remote-API disclosure and evidence are in [submission/](./submission/README.md).

## License

Apache 2.0. See [LICENSE](./LICENSE).
