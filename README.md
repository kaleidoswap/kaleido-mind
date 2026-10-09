# kaleido-mind

KaleidoMind is a TypeScript engine for building AI assistants that use Bitcoin
wallet tools. It handles tool calls, skills, multi-step recipes and confirmation
callbacks. Your application supplies the model, wallet connections and interface.

## Choose your starting point

| I want to… | Start here |
|---|---|
| Try an agent without a model download or node | [Create a project](#start-a-project), then `npm run start:offline` |
| Add Bitcoin tools to an existing MCP client | [Use the MCP server](#use-with-claude-code--claude-desktop); you do not need to embed Mind |
| Add an agent to my application | [Core package quickstart](./packages/core/README.md) |
| Connect a real RGB node | [RGB agent example](./examples/rgb-agent/README.md) |
| Understand the components | [Architecture](./docs/ARCHITECTURE.md) |
| Contribute or run checks | [Development](#development) |

**Requirements:** Node.js 20+ for the examples; pnpm 9 for repository development.
QVAC is optional and needed only for on-device inference. An OpenAI-compatible
model server or the scripted offline provider can be used instead. See the
[package requirements](./packages/core/README.md#install) before choosing a runtime.

## Start a project

```bash
npm create @kaleidorg/mind my-agent
cd my-agent && npm install
npm run start:offline   # fake node + scripted model: checks the setup, no download
npm run start:mock      # optional next step: fake node + local model download
```

The starter is a standalone copy of [`examples/rgb-agent`](./examples/rgb-agent):
a local model that operates an RGB Lightning Node on signet, with an eval
(`npm run eval:mock`). It runs on QVAC by default; with Ollama, LM Studio or any
OpenAI-compatible server, set `OPENAI_BASE_URL` and `OPENAI_MODEL`.

## Use it in your app

```bash
npm i @kaleidorg/mind @qvac/sdk
```

`@qvac/sdk` is only needed for on-device QVAC models. To use a model you
already serve, use `createOpenAICompatibleProvider` from
`@kaleidorg/mind/openai` instead.

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
server reads these variables from your environment:

| Variable | Default | Purpose |
|---|---|---|
| `KALEIDO_NETWORK` | `signet` | KaleidoSwap network preset (kaleido-mcp 0.3.0+) |
| `RLN_NODE_URL` | `http://localhost:3001` | your RGB Lightning Node API |

There is no public mainnet KaleidoSwap API: with `KALEIDO_NETWORK=mainnet`,
kaleido-mcp 0.3.1+ also needs `KALEIDOSWAP_API_URL` set to your maker endpoint.

**Spark and Liquid wallets.** Since kaleido-mcp 0.3.1 these are optional peer
dependencies that plain `npx -y kaleido-mcp` does not install; with `WDK_SEED`
or `LIQUID_MNEMONIC` set but the package missing, the server starts and logs an
install hint. To enable them, add the packages to the command and pass the seeds:

```json
{
  "mcpServers": {
    "kaleido": {
      "command": "npx",
      "args": ["-y", "-p", "kaleido-mcp", "-p", "@tetherto/wdk-wallet-spark",
               "-p", "@kaleidorg/wdk-wallet-liquid", "kaleido-mcp"],
      "env": { "KALEIDO_NETWORK": "signet", "WDK_SEED": "...", "LIQUID_MNEMONIC": "..." }
    }
  }
}
```

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
`kaleido-node`, `kaleido-trading` (atomic swaps), `channel-manager`
(channels, liquidity, LSP orders), `portfolio-manager` (rebalancing, DCA),
`submarine-swaps` and `paid-data` use tools that kaleido-mcp provides. The other skills call tools
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
| [`rgb-agent`](./examples/rgb-agent) | A local model operates an RGB Lightning Node through kaleido-mcp on signet: RGB balances, RGB invoice, asset send behind a confirm gate. Also what `npm create @kaleidorg/mind` generates | `pnpm start` / `pnpm start:mock` / `pnpm start:offline` / `pnpm eval:mock` |

```bash
corepack enable
pnpm install && pnpm build
cd examples/node-minimal && pnpm start      # downloads Qwen3.5 2B (~1.3 GB) on first run
cd ../rgb-agent && pnpm start:mock          # fake RLN node, real local model
```

## How it works

1. **Pluggable tool sources.** Use in-process wallet adapters, MCP or a CLI.
   The model sees the connected source's actual schemas. Some wire names and
   arguments differ from the in-process contracts; [MCP integration](./packages/core/README.md#connecting-an-mcp-server)
   explains normalization and compatibility.
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

**Confirmation is enforced for classified tools.** Tools marked
`requiresConfirmation` pause for the host's confirmation callback and are denied
if no callback is supplied. Mark custom spending tools explicitly; the engine
cannot infer the effects of an arbitrary handler. The sheet shows a deterministic
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
