/**
 * Skill bundle — the RN-safe counterpart to the Node fs loader.
 *
 * React Native has no filesystem, so a skill folder can't be read at runtime.
 * Instead a build step serialises the skills into a `SkillBundle` (plain JSON:
 * each skill's raw SKILL.md text + its reference files), and the app rehydrates
 * them here with `skillsFromBundle()`. Same skills, same SKILL.md authoring —
 * just delivered as data instead of files.
 *
 * Pure, dependency-free, no fs/url imports — safe to import from the package's
 * main entry on any host.
 */

import type { Skill, SkillReference } from './types.js';
import { parseSkill } from './registry.js';

/** One serialised skill: the SKILL.md text + its reference files. */
export interface BundledSkill {
  /** Folder name (informational; the real name comes from the frontmatter). */
  dir?: string;
  /** Raw SKILL.md contents. */
  markdown: string;
  /** references/*.md files. */
  references?: SkillReference[];
}

/** A bundle of skills produced by the bundler script. */
export interface SkillBundle {
  version: 1;
  skills: BundledSkill[];
}

/** Rehydrate Skills from a bundle (RN-safe — no filesystem). */
export function skillsFromBundle(bundle: SkillBundle): Skill[] {
  if (!bundle || bundle.version !== 1 || !Array.isArray(bundle.skills)) {
    throw new Error('skillsFromBundle: not a valid v1 SkillBundle');
  }
  return bundle.skills.map((b) => ({
    ...parseSkill(b.markdown, b.references),
    dir: b.dir,
  }));
}
