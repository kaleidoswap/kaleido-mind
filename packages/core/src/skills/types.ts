/**
 * Skills — curated capability bundles the brain can "enter".
 *
 * A skill is the top layer of tool use: it scopes the agent to a domain by
 * injecting focused instructions (a playbook) and exposing only the relevant
 * subset of tools. The tools themselves are still invoked via function calling
 * and may be backed by in-process handlers or MCP servers — skills don't
 * replace those, they *direct* them.
 *
 * This is progressive disclosure: a small local model never sees all 64 tools
 * or every instruction at once — only what the selected skill needs.
 */

export interface Skill {
  /** Stable id, e.g. "portfolio-manager". */
  name: string;
  /** One-line "when to use this" — used for routing/selection. */
  description: string;
  /** The playbook: markdown instructions injected into the system prompt. */
  instructions: string;
  /**
   * Tool names this skill is allowed to use. When set, the engine exposes only
   * these tools while the skill is active (progressive disclosure). Omit to
   * allow all registered tools.
   */
  tools?: string[];
  /** Optional trigger keywords to boost selection (in addition to description). */
  triggers?: string[];
}

/** Picks the most relevant skill for a query (or null for none). */
export interface SkillSelector {
  select(query: string, skills: Skill[]): Skill | null;
}
