/**
 * Skill reference tool source — the read-side of Agent-Skills progressive
 * disclosure.
 *
 * Exposes one tool, `read_skill_reference({ file, skill? })`, that returns the
 * contents of a `references/*.md` file bundled with a skill. The brain enters a
 * skill (its SKILL.md playbook lists the reference files), then pulls in only
 * the reference it needs for the current step — instead of every doc being in
 * context at once.
 *
 * Pure in-process: it reads from the SkillRegistry's already-loaded reference
 * strings, so it works on every host (React Native included) once the skills
 * are loaded. No filesystem, no network.
 */

import type { ToolDef } from '../types.js';
import type { ToolSource } from '../tools/source.js';
import { SkillRegistry, READ_REFERENCE_TOOL } from './registry.js';

export function createSkillReferenceToolSource(registry: SkillRegistry): ToolSource {
  const tool: ToolDef = {
    name: READ_REFERENCE_TOOL,
    description:
      'Read a reference document bundled with the active skill (its SKILL.md ' +
      'lists the available files). Use this to pull in the detailed instructions ' +
      'for a step — e.g. the MCP, CLI, or API guide — before acting.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Reference filename, e.g. "mcp.md"' },
        skill: { type: 'string', description: 'Optional skill name to scope the lookup' },
      },
      required: ['file'],
    },
  };

  async function execute(_name: string, args: Record<string, unknown>): Promise<unknown> {
    const file = String(args.file ?? '').trim();
    if (!file) throw new Error('read_skill_reference: file is required');
    const skill = args.skill ? String(args.skill) : undefined;
    const ref = registry.reference(file, skill);
    if (!ref) {
      const available = registry
        .references()
        .map((r) => `${r.skill}/${r.name}`)
        .join(', ');
      throw new Error(
        `read_skill_reference: "${file}" not found. Available: ${available || '(none)'}`,
      );
    }
    return ref.content;
  }

  return {
    id: 'skill-references',
    listTools: () => [tool],
    has: (name) => name === READ_REFERENCE_TOOL,
    execute,
  };
}
