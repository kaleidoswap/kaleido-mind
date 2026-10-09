# @kaleidorg/mind

A local-first reasoning and function-calling engine for Bitcoin wallets. You
bring a model (usually [QVAC](https://www.npmjs.com/package/@qvac/sdk) running
on-device) and some tools; `@kaleidorg/mind` runs the agent loop, routes
requests through skills and recipes, and asks your app to approve tools marked
`requiresConfirmation` before they run.

- **Pure TypeScript, no runtime dependencies.** It runs in Node, Bare and React
  Native. `@qvac/sdk` is an optional peer and is only imported as types.
- **One tool contract, many transports.** Wallet tools (`spark_*`, `rln_*`,
  `arkade_*`, `liquid_*` plus router helpers) have fixed names and JSON schemas.
  Bind in-process handlers to those contracts, or discover an MCP/CLI source
  using its actual schemas. See [MCP compatibility](#connecting-an-mcp-server)
  for differences in names and arguments.
- **Confirm-before-spend is built in.** Built-in spending contracts are flagged
  `requiresConfirmation`; set this flag for custom tools that move funds. The engine calls your `onConfirm` and does not run
  the tool until you approve.
- **Small-model friendly.** Skills scope each turn to a few tools. Recipes run
  multi-step flows with roughly one inference. A fast path answers simple reads
  with no inference at all.

## Install

```bash
npm i @kaleidorg/mind @qvac/sdk
```

You need `@qvac/sdk` only to run QVAC models. The engine accepts any
`LLMProvider`: `@kaleidorg/mind/openai` talks to any OpenAI-compatible server
(see below), and `@kaleidorg/mind/testing` includes a scripted provider that
needs no model. To connect MCP servers, also install
`@modelcontextprotocol/sdk`.

| `@qvac/sdk` | Status |
|---|---|
| 0.20 – 0.21 | Supported (tested with 0.21.0). |
| < 0.20 | Not supported from mind 0.9: the provider sends `tool_choice` and `reasoning_budget`, which older SDKs reject or ignore. Upgrade QVAC before using the current Mind package. |

The Qwen3.5 model constants used below (`QWEN3_5_*_MULTIMODAL_Q4_K_M`) exist in
every supported `@qvac/sdk` version.

## First run without a model

Create a project that uses a fake wallet and scripted responses:

```bash
npm create @kaleidorg/mind my-agent
cd my-agent
npm install
npm run start:offline
```

Expected result: sample balances, a mock RGB invoice and a simulated transfer.
No node, model download or wallet funds are needed. Next use `npm run start:mock`
to try a local model, or follow the generated README to connect a signet node.
The offline script auto-approves only its simulated operations.

## Models

We recommend Qwen3.5. Qwen3 (0.6B–4B) and Hermes 3 kept mangling the arguments of
multi-field wallet calls such as `rln_issue_asset`, so they are no longer in the
catalog; any GGUF still loads by path or Hugging Face URL.

| Model | `@qvac/sdk` constant | Download | RAM | Use |
|---|---|---|---|---|
| Qwen3.5 0.8B | `QWEN3_5_0_8B_MULTIMODAL_Q4_K_M` | 0.53 GB | ~1.5 GB | Smoke tests only; loops on wallet actions |
| Qwen3.5 2B | `QWEN3_5_2B_MULTIMODAL_Q4_K_M` | 1.3 GB | ~3 GB | **Default.** All 7 signet RGB wallet tasks passed, 45–150 s per question on an M4 |
| Qwen3.5 4B | `QWEN3_5_4B_MULTIMODAL_Q4_K_M` | 2.7 GB | ~5 GB | Same correctness, ~2× slower (105–330 s) |
| Qwen3.5 9B | `QWEN3_5_9B_MULTIMODAL_Q4_K_M` | 5.7 GB | ~9 GB | 16 GB machines; slow for chat (180–690 s) |
| Qwen3.6 35B-A3B (MoE) | `QWEN3_6_35B_A3B_MULTIMODAL_Q4_K_M` | 22 GB | ~26 GB | 32 GB+ machines |

The same list is exported as data from `@kaleidorg/mind/qvac` (`QWEN35_MODELS`,
`DEFAULT_MODEL_ID`, `DEFAULT_QVAC_MODEL`, `DEFAULT_SMALL_DEVICE_QVAC_MODEL`).
Only the text weights are loaded; the vision projector is not needed.

## Quickstart (5 minutes)

This example loads a small GGUF model through QVAC, registers one tool and one
skill, and runs one turn.

```ts
// quickstart.ts — run with: npx tsx quickstart.ts
import { completion, cancel, loadModel, unloadModel, close, QWEN3_5_2B_MULTIMODAL_Q4_K_M } from '@qvac/sdk';
import { Engine, InProcessToolSource, SkillRegistry, ToolRegistry } from '@kaleidorg/mind';
import { createQvacProvider } from '@kaleidorg/mind/qvac';

// 1. Model: Qwen3.5 2B Q4 (~1.3 GB, cached after the first download).
const modelId = await loadModel({
  modelSrc: QWEN3_5_2B_MULTIMODAL_Q4_K_M,
  modelConfig: { ctx_size: 4096, tools: true }, // `tools: true` turns on tool calling
});
const provider = createQvacProvider({ completion, cancel, getModelId: () => modelId, defaultTemperature: 0.2 });

// 2. Tool: a JSON-Schema definition plus a handler that runs in your process.
const tools = new ToolRegistry([
  new InProcessToolSource('demo', [
    {
      name: 'get_btc_price',
      description: 'Get the current BTC price in a fiat currency.',
      parameters: {
        type: 'object',
        properties: { fiat: { type: 'string', description: "ISO code, e.g. 'EUR'" } },
        required: ['fiat'],
      },
      handler: async ({ fiat }) => ({ fiat, price: 60_000 }),
    },
  ]),
]);

// 3. Skill: a SKILL.md playbook that scopes the model to the tools it needs.
const skills = new SkillRegistry().addMarkdown(`---
name: price-check
description: Answer questions about the bitcoin price.
tools: get_btc_price
triggers: price, btc, bitcoin
---
Call get_btc_price, then answer in one sentence with the number.`);

// 4. A turn.
const question = 'What is bitcoin worth in EUR?';
const engine = new Engine({ provider, tools });
// composeSkill picks a skill that can act with these tools, then composes its prompt.
const { system, allowedTools } = await engine.composeSkill(skills, question, 'You are a concise assistant.');
const result = await engine.runAgentic(
  [{ role: 'system', content: system }, { role: 'user', content: question }],
  { allowedTools },
);
console.log(result.text); // "Bitcoin is at 60,000 EUR."

await unloadModel({ modelId });
await close();
```

A runnable copy (with a `--mock` mode) is in
[`examples/node-minimal`](https://github.com/kaleidoswap/kaleido-mind/tree/main/examples/node-minimal).

## First run without a model

Create a project that uses a fake wallet and scripted responses:

```bash
npm create @kaleidorg/mind my-agent
cd my-agent
npm install
npm run start:offline
```

Expected result: sample balances, a mock RGB invoice and a simulated transfer.
No node, model download or wallet funds are needed. Next use `npm run start:mock`
to try a local model, or follow the generated README to connect a signet node.
The offline script auto-approves only its simulated operations.

## Models you already serve

`createOpenAICompatibleProvider` runs the same engine on any server that speaks
the OpenAI Chat Completions API with tool calling: Ollama, LM Studio, llama.cpp
`llama-server`, vLLM, `qvac serve` or a hosted API. It has no dependencies
(it uses `fetch`).

```ts
import { createOpenAICompatibleProvider } from '@kaleidorg/mind/openai';

const provider = createOpenAICompatibleProvider({
  baseUrl: 'http://localhost:11434/v1', // Ollama
  model: 'qwen3.5:2b',
  apiKey: process.env.OPENAI_API_KEY,    // optional; sent as a bearer token
  defaultTemperature: 0.1,
  defaultMaxTokens: 1536,
});
```

It streams tokens, forwards `toolChoice` as `tool_choice`, reports arguments
that are not valid JSON as `toolErrors` (so the engine retries once), and
aborts the request on `signal`. Reasoning deltas (`reasoning_content`) go to
`onThinking`. Server-specific fields go in `extraBody`.

## Subpath exports

| Import | What it gives you | Runtime |
|---|---|---|
| `@kaleidorg/mind` | `Engine`, `Funnel` (fast-path → recipe → agent), `ToolRegistry`, `InProcessToolSource`, `SkillRegistry`, the wallet contract and binder, `confirmReadback`, recipes, memory, RAG, context budgeting, L402 and CLI tool sources | Any (RN-safe) |
| `@kaleidorg/mind/qvac` | `createQvacProvider`, `toQvacTools`, `consumeRun`, voice (`createQvacVoice`, `runVoiceAssistant`), model configs | Any; you inject the SDK functions |
| `@kaleidorg/mind/openai` | `createOpenAICompatibleProvider` for Ollama, LM Studio, llama.cpp, vLLM, hosted APIs | Any with `fetch` |
| `@kaleidorg/mind/kaleidoswap` · `/lsps1` · `/submarine` · `/bitrefill` · `/flashnet` | Each domain's tool contract (`*_TOOLS`, `bind*Tools`) and its recipes. Also re-exported from the root until 1.0 | Any |
| `@kaleidorg/mind/knowledge` | Knowledge packs (`BITCOIN_COPILOT_DOCS`), corpus adapters for RAG, `createBtcMapToolSource` | Any |
| `@kaleidorg/mind/mcp` | `McpToolSource`: tools from an MCP server over stdio or streamable HTTP | Node |
| `@kaleidorg/mind/skills` | `loadSkillsDir`, `loadSkillFromDir`, `packagedSkillsDir()` (the 14 bundled skills) | Node (fs) |
| `@kaleidorg/mind/testing` | `MockWallet` (stateful fake wallet bound to the real contract), `scriptedProvider` | Any |
| `@kaleidorg/mind/logger` | `TurnLogger` for JSONL turn logs with PII masking | Any |

React Native hosts can't read skill folders from disk. Bundle them at build time
with `node node_modules/@kaleidorg/mind/scripts/bundle-skills.mjs --out skills.bundle.json <dirs…>`,
then load the bundle with `skillsFromBundle()`.

## Writing a tool

A tool is a `ToolDef` (`name`, `description`, `parameters` as JSON Schema) plus a
handler. Put tools in a `ToolSource` and give a `ToolRegistry` to the engine.

```ts
new InProcessToolSource('my-tools', [
  {
    name: 'send_tip',
    description: 'Tip a creator over Lightning.',
    parameters: {
      type: 'object',
      properties: { to: { type: 'string' }, amount_sats: { type: 'number' } },
      required: ['to', 'amount_sats'],
    },
    requiresConfirmation: true,        // the engine calls onConfirm first
    handler: async ({ to, amount_sats }) => myWallet.pay(to, amount_sats),
  },
]);
```

Tips for small models:

- Keep descriptions short and say when to use the tool.
- Return compact JSON. Pass `compressToolOutput: true` to `Engine` / `Funnel` to
  trim large results before they reach the model's context.
- If a handler throws, the engine passes `{ error }` to the model. It never
  crashes the loop.

## Writing a skill

A skill is a folder with a `SKILL.md`, using the Agent Skills format: YAML
frontmatter plus a markdown playbook. It can also have `references/*.md` files
that the model loads on demand through `read_skill_reference`.

```markdown
---
name: tipping
description: Tip creators. Use when the user says tip, zap or send a tip.
tools: resolve_contact, send_tip
triggers: tip, zap
---
1. Resolve the name with resolve_contact.
2. Call send_tip with the resolved address and the amount in sats.
Never guess an address.
```

```ts
import { loadSkillsDir, packagedSkillsDir } from '@kaleidorg/mind/skills';
const skills = new SkillRegistry([...loadSkillsDir(packagedSkillsDir()), ...loadSkillsDir('./skills')]);
// Skips skills whose tools the engine's registry lacks (e.g. spark-wallet with
// no Spark tools), so the model never runs inside a skill it can't act in.
const { skill, system, allowedTools } = await engine.composeSkill(skills, userText, baseSystem);
```

`skills.select()` alone only scores keywords; prefer `engine.composeSkill()`
(or `selectAvailableSkill(skills, text, liveToolNames)`). The `Funnel` does this
for you.

## The wallet tool contract

`WALLET_TOOLS` is the single source of truth for wallet tool names, schemas and
spend flags. Use `walletTools({ layers })` to select tools,
`bindWalletTools(handlers, opts)` to get an `InProcessToolSource`, and
`isSpendTool(name)` / `SPEND_TOOLS` to check spend flags.

| Layer | Tools |
|---|---|
| Spark | `spark_get_balance`, `spark_get_address`, `spark_get_onchain_address`, `spark_create_invoice`, `spark_pay_invoice` 🔒, `spark_send` 🔒 |
| RLN / RGB | `rln_get_node_info`, `rln_get_balances`, `rln_list_assets`, `rln_get_asset_balance`, `rln_list_transfers`, `rln_refresh_transfers`, `rln_get_address`, `rln_list_channels`, `rln_list_payments`, `rln_list_swaps`, `rln_get_swap`, `rln_get_channel_id`, `rln_connect_peer`, `rln_create_ln_invoice`, `rln_create_rgb_invoice`, `rln_pay_invoice` 🔒, `rln_send_asset` 🔒, `rln_send_btc` 🔒, `rln_open_channel` 🔒, `rln_close_channel` 🔒, `rln_atomic_taker` 🔒, `rln_create_utxos` 🔒, `rln_issue_asset` 🔒 |
| Arkade | `arkade_get_balance`, `arkade_get_address`, `arkade_send` 🔒 |
| Liquid | `liquid_get_balance`, `liquid_create_invoice`, `liquid_send` 🔒 |
| Router | `get_balances`, `resolve_contact`, `get_price`, `fiat_to_sats`, `get_swap_quote`, `execute_swap` 🔒, `send_payment` 🔒, `create_invoice` |

🔒 = `requiresConfirmation`. `confirmReadback(call)` turns a pending call into a
deterministic sentence for your confirm sheet, e.g. *"Send 5 USDT to utxob:…ij90
over RLN. Confirm?"*.

### Agent guards

The engine and funnel check the model's tool use before anything reaches the
user:

- **Schema validation.** Arguments are checked against the tool's JSON Schema
  (or Zod schema) before `onConfirm`: required fields, types, enums, ranges,
  finite numbers. Invalid calls go back to the model as a tool error and the
  user is never asked. `onConfirm` receives the validated arguments plus a
  `summary` readback.
- **Repeated calls.** A second identical call (same name and arguments) is not
  re-run; the model gets the earlier result and is told to answer. A third
  forces a final answer with no tools.
- **Declines end the turn.** When the user declines every call in a turn, the
  run ends with a fixed reply ("Cancelled — you declined: Create 5 RGB UTXOs
  on-chain over RLN. Nothing was sent or changed.") and no further inference.
  The tool result in history is the same for every tool:
  `{ status: 'cancelled_by_user', declined_by: 'user', tool, message }`.
  Turn it off with `endTurnOnDecline: false`.
- **No empty answers.** If the model runs tools but its answer comes back empty
  (reasoning used the output budget), the engine asks once more without tools,
  then falls back to showing the last tool result.
- **No made-up payment data.** A final answer containing an invoice, offer,
  address or RGB invoice that no tool returned and the user never typed is
  replaced with a refusal (`guardUngroundedPaymentData`, default on).
- **Skills that can act.** `engine.composeSkill()` and the funnel skip skills
  whose `requires-tools` are not live and prefer skills with at least one live
  tool. If the request is a wallet action (create an invoice, get an address,
  pay, send) and no exposed tool can do it, the engine answers "I can't do that
  here" without calling the model (`guardMissingTools`, default on).

Qwen3.5 reasons before it answers: in our signet runs the 2B model used 80–390
thinking tokens per turn. Keep `maxThinkingTokens` around 512 and the output cap
(`defaultMaxTokens`) well above it (we use 1536); a tighter cap cuts the turn
off before it calls a tool or answers.

```ts
const wallet = bindWalletTools(
  { rln_list_assets: async () => rln.listAssets(), rln_send_asset: async (a) => rln.sendAsset(a) /* … */ },
  { layers: ['rln'], includeCore: false, allowMissing: true },
);
```

Tools without a handler are skipped when `allowMissing` is set. The `rln_*`
names match [kaleido-mcp](https://www.npmjs.com/package/kaleido-mcp), so a
desktop host can use the MCP server and a mobile host can use in-process
handlers. `rln_send_asset` and `rln_create_rgb_invoice` take
`asset` / `amount` / `to` in the contract but `asset_id` / `amount` /
`recipient_id` in kaleido-mcp. The model always sees the schema of the source
it is connected to, and the bundled `rgb-lightning-node` skill describes both.

## Connecting an MCP server

```ts
import { McpToolSource } from '@kaleidorg/mind/mcp';

const kaleido = new McpToolSource({
  id: 'kaleido',
  transport: {
    kind: 'stdio',
    command: 'npx',
    args: ['-y', 'kaleido-mcp'],
    env: { KALEIDO_NETWORK: 'signet', RLN_NODE_URL: 'http://localhost:3001' }, // PATH/HOME are inherited
  },
  allow: ['rln_list_assets', 'rln_get_asset_balance', 'rln_create_rgb_invoice', 'rln_send_asset'],
});
await kaleido.connect();
const tools = new ToolRegistry([kaleido]);
// … engine.runAgentic(…) …
await kaleido.close();
```

- `allow` keeps the tool list short, which matters for small models.
- `denyPrefixes` hides whole groups of tools.
- For a remote server, use `{ kind: 'http', url, headers }`.
- Known spend tools, their RLN/WDK aliases, signing and node mutation tools are
  confirmation-gated even over MCP. A custom tool still needs an explicit risk
  classification; descriptions are only a compatibility fallback.
- Allow/deny filters are enforced on direct `execute()` calls too.
- For Kaleido MCP, Mind exposes `spark_pay_invoice` as the BOLT11 payer and routes
  it to `spark_pay_lightning_invoice`. Spark invoices remain available as
  `spark_pay_spark_invoice`. The discovered schemas describe the supported
  arguments: the MCP BOLT11 payer does not support amount overrides, so use an
  invoice with an encoded amount. This normalization is part of the next Mind
  release; raw MCP clients retain Kaleido MCP's original tool names.
- `KALEIDO_NETWORK=signet` needs kaleido-mcp 0.3.0 or later. On older versions,
  set `RLN_NODE_URL` and `KALEIDOSWAP_API_URL` explicitly.

[`examples/rgb-agent`](https://github.com/kaleidoswap/kaleido-mind/tree/main/examples/rgb-agent)
is a complete local agent built this way. It checks RGB balances, creates an RGB
invoice and sends an asset. It also has a mock mode that runs without a node.

## Testing without a node, funds or a model

```ts
import { Funnel, issueAssetRecipe } from '@kaleidorg/mind';
import { MockWallet, scriptedProvider } from '@kaleidorg/mind/testing';

const wallet = new MockWallet();
const funnel = new Funnel({ provider: scriptedProvider(), tools: wallet.registry(), recipes: [issueAssetRecipe] });
const out = await funnel.runTurn('issue 1000 TICKET tokens called Hackathon Ticket', {
  onConfirm: async () => ({ approved: true }),
});
console.log(out.text, wallet.sends);
```

## More

- [Architecture](https://github.com/kaleidoswap/kaleido-mind/blob/main/docs/ARCHITECTURE.md)
- [Function calling](https://github.com/kaleidoswap/kaleido-mind/blob/main/docs/FUNCTION_CALLING.md)
- [Memory and RAG](https://github.com/kaleidoswap/kaleido-mind/blob/main/docs/MEMORY_RAG.md)
- [Integrating into a host](https://github.com/kaleidoswap/kaleido-mind/blob/main/docs/INTEGRATION.md)
- [Changelog](https://github.com/kaleidoswap/kaleido-mind/blob/main/CHANGELOG.md)

Apache-2.0

## Evaluation and future training data

See [agent evaluation and datasets](../../docs/DATASETS.md) for opt-in local collection, voice
latency/error metrics, retention/deletion and reviewed JSONL exports. Start with
`pnpm dataset:eval --mock` from the repository root after building. Evaluation
records never become training examples automatically.
