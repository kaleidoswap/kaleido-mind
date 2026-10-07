# Skills

Agent Skills the `@kaleidorg/mind` engine loads at runtime (Anthropic Agent
Skills format, so the same folders also work as Claude Code skills). For each
query the engine picks one skill, appends its body to the system prompt and
limits the model to that skill's tools. Long reference material lives in
`references/*.md` and is read on demand with the `read_skill_reference` tool.

## Shipped skills

| Skill | Use | Tools from |
|---|---|---|
| `rgb-lightning-node` | RGB holdings, issuance, RGB/Lightning invoices, sends | kaleido-mcp or in-app |
| `kaleido-trading` | KaleidoSwap quotes and atomic swaps | kaleido-mcp or in-app |
| `kaleido-node` | Start, stop, init and unlock the node | kaleido-mcp |
| `channel-manager` | Channels, liquidity, LSP channel orders, heartbeat | kaleido-mcp |
| `portfolio-manager` | Allocation, rebalancing, DCA | kaleido-mcp or in-app |
| `submarine-swaps` | Pay Lightning from Liquid (L-USDT, L-BTC) | kaleido-mcp or in-app |
| `paid-data` | L402 / MPP paywalled APIs | kaleido-mcp or in-app |
| `wallet-assistant` | In-app balances, receive, send, contacts | in-app |
| `spark-wallet` | In-app Spark wallet | in-app |
| `flashnet-swaps` | BTC ↔ Spark tokens on Flashnet | in-app |
| `merchant-finder` | Places that accept Bitcoin (BTC Map) | in-app |
| `bitrefill` | Gift cards, top-ups, eSIMs (adapted from [bitrefill/agents](https://github.com/bitrefill/agents), MIT) | in-app |

"in-app" tools come from the contracts in `src/` (`wallet/`, `kaleidoswap/`,
`submarine/`, `flashnet/`, `bitrefill/`, …). Where a tool exists both in-app
and in kaleido-mcp it takes the same arguments in the same units, so one
example fits both.

## Writing a skill

```markdown
---
name: my-skill
description: "One sentence: what it does and when to use it. This drives selection."
tools: rln_list_assets, rln_send_asset
requires-tools: rln_list_assets
triggers: token, send token
---
# My skill

One or two lines of context: units, where ids come from.

## Do
- Short, factual rules about the API: which tool for which intent, which
  argument comes from which earlier result, what is confirm-gated.

## Examples
- "Send 5 SKT to rgb:…/utxob:abc" → `rln_list_assets {}` then `rln_send_asset {"asset_id":"<SKT asset_id>","recipient_id":"utxob:abc","amount":5}`
```

- `tools` — the only tools the model sees while the skill is active.
- `requires-tools` — the skill is skipped unless all of these are live. Use it
  to keep a skill off hosts that can't run it (an in-app-only tool such as
  `get_balances` keeps a skill in the app).
- `triggers` — keywords that boost selection; the description counts too.
- Examples are written as `` `tool_name {json}` `` with the exact argument names
  and units of the tool schema; use `"<…>"` for values that come from an earlier
  result. Keep the body under ~400 tokens and move detail to `references/`.

`src/skills/catalog.test.ts` checks every skill: each tool exists in the
in-app contracts or in kaleido-mcp, each example parses and uses valid argument
names (and values) on every surface that has the tool, and the body stays short.
Run it with `pnpm --filter @kaleidorg/mind test`.

## Integrate in 3 steps

1. **Connect tools.** Start kaleido-mcp and wrap it as a tool source, and/or
   bind your own handlers to a contract:

   ```ts
   import { Engine, ToolRegistry, bindWalletTools } from '@kaleidorg/mind';
   import { McpToolSource } from '@kaleidorg/mind/mcp';

   const mcp = new McpToolSource({ id: 'kaleido', transport: { kind: 'stdio', command: 'npx', args: ['-y', 'kaleido-mcp'] } });
   await mcp.connect();
   const engine = new Engine({ provider, tools: new ToolRegistry([mcp]) });
   ```

2. **Load skills.** Node reads the folders; React Native ships a bundle:

   ```ts
   import { SkillRegistry } from '@kaleidorg/mind';
   import { loadSkillsDir, packagedSkillsDir } from '@kaleidorg/mind/skills';
   const skills = new SkillRegistry([...loadSkillsDir(packagedSkillsDir()), ...loadSkillsDir('./my-skills')]);
   ```

   ```bash
   node node_modules/@kaleidorg/mind/scripts/bundle-skills.mjs --out skills.bundle.json \
     node_modules/@kaleidorg/mind/skills/kaleido-trading ./skills
   ```

3. **Run a query.** `composeSkill` picks a skill that can act with the live
   tools and returns the prompt and tool scope:

   ```ts
   const { system, allowedTools } = await engine.composeSkill(skills, question, basePrompt);
   const res = await engine.runAgentic([{ role: 'system', content: system }, { role: 'user', content: question }], {
     allowedTools,
     onConfirm: async (call) => ({ approved: await askUser(call.summary) }),
   });
   ```

To expose the reference files, add `createSkillReferenceToolSource(skills)` to
the `ToolRegistry`.

## Keeping the kaleido-mcp snapshot current

`src/skills/mcp-tools.snapshot.json` lists kaleido-mcp's tools and argument
schemas. After a kaleido-mcp release:

```bash
git clone https://github.com/kaleidoswap/kaleido-mcp ../kaleido-mcp
(cd ../kaleido-mcp && npm ci && npm run build)
node packages/core/scripts/snapshot-mcp-tools.mjs ../kaleido-mcp
```
