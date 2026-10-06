# @kaleidorg/mind

A local-first reasoning and function-calling engine for Bitcoin wallets. You
bring a model (usually [QVAC](https://www.npmjs.com/package/@qvac/sdk) running
on-device) and some tools; `@kaleidorg/mind` runs the agent loop, routes
requests through skills and recipes, and stops before any spend until your app
confirms it.

- **Pure TypeScript, no runtime dependencies.** It runs in Node, Bare and React
  Native. `@qvac/sdk` is an optional peer and is only imported as types.
- **One tool contract, many transports.** Wallet tools (`spark_*`, `rln_*`,
  `arkade_*`, `liquid_*` plus router helpers) have fixed names and JSON schemas.
  Bind them to in-process handlers, an MCP server or a CLI. The model sees the
  same tools on every surface.
- **Confirm-before-spend is built in.** Every tool that moves funds is flagged
  `requiresConfirmation`. The engine calls your `onConfirm` and does not run
  the tool until you approve.
- **Small-model friendly.** Skills scope each turn to a few tools. Recipes run
  multi-step flows with roughly one inference. A fast path answers simple reads
  with no inference at all.

## Install

```bash
npm i @kaleidorg/mind @qvac/sdk
```

You need `@qvac/sdk` only to run QVAC models. The engine accepts any
`LLMProvider`, and `@kaleidorg/mind/testing` includes a scripted provider that
needs no model. To connect MCP servers, also install
`@modelcontextprotocol/sdk`.

| `@qvac/sdk` | Status |
|---|---|
| 0.19 – 0.21 | Supported (tested with 0.21.0). There is no P2P delegated inference: QVAC removed `startQVACProvider` / `loadModel({ delegate })` in 0.19. |
| 0.13.1 – 0.18 | Supported, including P2P delegation (`buildDelegateConfig`, `allowListFirewall`). |

## Quickstart (5 minutes)

This example loads a small GGUF model through QVAC, registers one tool and one
skill, and runs one turn.

```ts
// quickstart.ts — run with: npx tsx quickstart.ts
import { completion, cancel, loadModel, unloadModel, close, QWEN3_1_7B_INST_Q4 } from '@qvac/sdk';
import { Engine, InProcessToolSource, SkillRegistry, ToolRegistry } from '@kaleidorg/mind';
import { createQvacProvider } from '@kaleidorg/mind/qvac';

// 1. Model: Qwen3 1.7B Q4 (~1 GB, cached after the first download).
//    QWEN3_600M_INST_Q4 (~380 MB) also works but is weaker at tool calls.
const modelId = await loadModel({
  modelSrc: QWEN3_1_7B_INST_Q4,
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
const { system, allowedTools } = skills.compose('You are a concise assistant.', skills.select(question));
const engine = new Engine({ provider, tools });
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

## Subpath exports

| Import | What it gives you | Runtime |
|---|---|---|
| `@kaleidorg/mind` | `Engine`, `Funnel` (fast-path → recipe → agent), `ToolRegistry`, `InProcessToolSource`, `SkillRegistry`, wallet / KaleidoSwap / LSPS1 / Bitrefill / Flashnet contracts and binders, `confirmReadback`, recipes, memory, RAG, context budgeting, L402 and CLI tool sources | Any (RN-safe) |
| `@kaleidorg/mind/qvac` | `createQvacProvider`, `toQvacTools`, `consumeRun`, voice (`createQvacVoice`, `runVoiceAssistant`), model configs, delegation helpers | Any; you inject the SDK functions |
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
const skill = skills.select(userText);                 // keyword selector by default
const { system, allowedTools } = skills.compose(baseSystem, skill);
```

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
- Spend tools from the contracts stay confirmation-gated even when they come
  over MCP.
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
