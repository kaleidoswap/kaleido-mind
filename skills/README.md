# Skills

Claude-style **Agent Skills** the KaleidoMind brain (QVAC) loads at runtime.

Each subfolder is a skill: a `SKILL.md` (YAML frontmatter + playbook) plus
optional `references/*.md` files loaded on demand (progressive disclosure).
The format is the Anthropic Agent Skills spec, so skills published for Claude
run the QVAC brain unchanged.

Load them on Node hosts with:

```ts
import { loadSkillsDir } from '@kaleidorg/mind/skills';
import { SkillRegistry, createSkillReferenceToolSource } from '@kaleidorg/mind';

const skills = loadSkillsDir(new URL('./skills', import.meta.url).pathname);
const registry = new SkillRegistry(skills);
```

## Vendored skills

- **bitrefill/** — official Bitrefill agent skill (gift cards, mobile top-ups,
  eSIMs; pay in crypto / Lightning / USDC-x402 / balance). Routes the brain to
  its highest-fidelity channel; the preferred purchase path is the Bitrefill
  remote MCP at `https://api.bitrefill.com/mcp`.
  Source: https://github.com/bitrefill/agents (MIT). Update with
  `npx skills add bitrefill/agents` or re-vendor the `skills/bitrefill` folder.
