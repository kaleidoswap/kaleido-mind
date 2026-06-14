# Skills

Claude-style **Agent Skills** the KaleidoMind brain (QVAC) loads at runtime.
Skills are the top layer of tool use: entering one injects a focused playbook
into the system prompt and (optionally) scopes the model to a subset of tools —
*progressive disclosure*, so a small local model never sees every tool or
instruction at once.

Each subfolder is a skill: a `SKILL.md` (YAML frontmatter + playbook) plus
optional `references/*.md` files loaded on demand. The format is the Anthropic
Agent Skills spec, so skills published for Claude (e.g. `bitrefill/agents`) run
the QVAC brain unchanged.

## Frontmatter

```yaml
---
name: my-skill                 # required — stable id
description: When to use this…  # required — selection signal (embed triggers here)
tools: tool_a, tool_b          # optional — scope the model to these tools
triggers: foo, bar             # optional — keywords that boost selection
metadata:                      # optional — anything else (author, version, …)
  author: kaleidoswap
---
# Playbook
Markdown instructions injected into the system prompt when this skill is active.
```

## Loading (same skills, every surface)

**Node** (desktop sidecar, kaleidoagent) — read folders from disk:

```ts
import { loadSkillsDir, packagedSkillsDir } from '@kaleidorg/mind/skills';
import { SkillRegistry, createSkillReferenceToolSource } from '@kaleidorg/mind';

const skills = loadSkillsDir(packagedSkillsDir());   // these shipped skills
const registry = new SkillRegistry(skills);
const refSource = createSkillReferenceToolSource(registry); // read_skill_reference
```

**React Native** (rate) — no filesystem, so bundle the folders to JSON at build
time and rehydrate:

```bash
node node_modules/@kaleidorg/mind/scripts/bundle-skills.mjs \
  --out skills.bundle.json ./skills
```
```ts
import { SkillRegistry, skillsFromBundle } from '@kaleidorg/mind';
import bundle from './skills.bundle.json';
const registry = new SkillRegistry(skillsFromBundle(bundle));
```

Then per query: `const skill = registry.select(query)` →
`registry.compose(systemPrompt, skill)` → pass `{ system, allowedTools }` to
`engine.runAgentic(...)`.

## Adding a skill

1. Create `skills/<name>/SKILL.md` (and `references/*.md` if needed).
2. Node hosts pick it up automatically. For mobile, re-run the bundler.
3. That's it — no code changes. The selector routes to it by description/triggers.

## Shipped skills

- **bitrefill/** — official Bitrefill agent skill (gift cards, mobile top-ups,
  eSIMs; pay in crypto / Lightning / USDC-x402 / balance). Capability-routes to
  the best channel; preferred purchase path is the Bitrefill remote MCP at
  `https://api.bitrefill.com/mcp` (needs `BITREFILL_API_KEY` — anonymous = 401).
  Source: https://github.com/bitrefill/agents (MIT). Update with
  `npx skills add bitrefill/agents` or re-vendor the folder.
- **wallet-assistant/** — everyday wallet tasks (balance, receive, send, pay,
  price, fiat→sats, resolve a contact). Resolves to host-bound `wallet/contract.ts`
  tools (in-process WDK on mobile, MCP on desktop).
- **merchant-finder/** — find Bitcoin-accepting merchants via BTC Map. Live
  data when the host injects a fetch + location; bundled offline list otherwise.
- **paid-data/** — fetch L402-paywalled resources via `fetch_paid_resource`.
- **kaleido-trading/** — prices, quotes, atomic swaps, LSP channels.
