/**
 * Tool-aware skill selection: pick a skill that can actually act with the tools
 * a host has, before any inference runs.
 */

import type { ToolDef } from '../types.js';
import type { Skill } from './types.js';
import { READ_REFERENCE_TOOL, SkillRegistry } from './registry.js';

/** Every tool a skill names: its `requires-tools` plus its scoped `tools`. */
export function skillToolNames(skill: Skill): string[] {
  const required = (skill.metadata?.['requires-tools'] ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  return [...new Set([...required, ...(skill.tools ?? [])])].filter((t) => t !== READ_REFERENCE_TOOL);
}

/**
 * Whether a skill can act given the live tool names. A `requires-tools`
 * frontmatter list must be fully live; otherwise at least one of the skill's
 * scoped tools must be.
 */
export function skillAvailable(skill: Skill, present: ReadonlySet<string>): boolean {
  const required = skill.metadata?.['requires-tools'];
  if (required) {
    return required.split(',').map((t) => t.trim()).filter(Boolean).every((t) => present.has(t));
  }
  if (!skill.tools?.length) return true;
  return skill.tools.some((t) => t !== READ_REFERENCE_TOOL && present.has(t));
}

/**
 * Select the best skill for `query` among those that can act with `liveTools`.
 * Skills whose `requires-tools` are missing are never picked; a skill with zero
 * live tools is only a last resort.
 */
export function selectAvailableSkill(
  skills: SkillRegistry | readonly Skill[],
  query: string,
  liveTools: Iterable<string | Pick<ToolDef, 'name'>>,
): Skill | null {
  const list = skills instanceof SkillRegistry ? skills.list() : [...skills];
  const present = new Set([...liveTools].map((t) => (typeof t === 'string' ? t : t.name)));
  const usable = list.filter((s) => skillAvailable(s, present));
  return (
    new SkillRegistry(usable).select(query) ??
    new SkillRegistry(list.filter((s) => !s.metadata?.['requires-tools'] && !usable.includes(s))).select(query)
  );
}
