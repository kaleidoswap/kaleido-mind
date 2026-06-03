/**
 * Skill loader — reads Claude-style Agent Skill folders from disk. NODE ONLY.
 *
 * Import from `@kaleidorg/mind/skills` on Node hosts (desktop sidecar,
 * kaleidoagent). React Native has no filesystem — there, build skills with
 * `SkillRegistry.addMarkdown(text, references)` from bundled strings instead.
 *
 * Layout (Anthropic Agent Skills spec, e.g. bitrefill/agents):
 *
 *   skills/
 *     bitrefill/
 *       SKILL.md
 *       references/
 *         mcp.md
 *         cli.md
 *         …
 *
 * `loadSkillsDir(root)` returns one Skill per SKILL.md found, with every
 * reference markdown read into `skill.references` for progressive disclosure.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Skill, SkillReference } from './types.js';
import { parseSkill } from './registry.js';

/** Load one skill folder containing a SKILL.md (+ optional references/). */
export function loadSkillFromDir(dir: string): Skill {
  const skillFile = join(dir, 'SKILL.md');
  if (!existsSync(skillFile)) throw new Error(`No SKILL.md in ${dir}`);
  const markdown = readFileSync(skillFile, 'utf8');

  const refDir = join(dir, 'references');
  const references: SkillReference[] = existsSync(refDir)
    ? readdirSync(refDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((name) => ({ name, content: readFileSync(join(refDir, name), 'utf8') }))
    : [];

  return { ...parseSkill(markdown, references), dir };
}

/** Load every skill folder under `root` (each a dir with a SKILL.md). */
export function loadSkillsDir(root: string): Skill[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'SKILL.md')))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => loadSkillFromDir(join(root, e.name)));
}
