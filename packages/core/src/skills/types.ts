/**
 * Skills — Claude-style Agent Skills the brain can "enter".
 *
 * A skill is the top layer of tool use: a folder with a `SKILL.md` (YAML
 * frontmatter + a markdown playbook) and optional `references/*.md` files that
 * are loaded on demand. Entering a skill injects its playbook into the system
 * prompt and (optionally) scopes the agent to a subset of tools. The tools are
 * still invoked via function calling and may be backed by in-process handlers
 * or MCP servers — skills don't replace those, they *direct* them.
 *
 * This is progressive disclosure, the core idea behind Anthropic's Agent Skills:
 * a small local model never sees every tool or instruction at once — only the
 * selected skill's playbook, and it can pull a reference file in when it needs
 * the detail. The format is compatible with skills published for Claude (e.g.
 * `bitrefill/agents`), so the same SKILL.md runs the QVAC brain unchanged.
 */

/** A reference file (references/*.md) the agent can read on demand. */
export interface SkillReference {
  /** Filename, e.g. "mcp.md". */
  name: string;
  /** Markdown contents. */
  content: string;
}

export interface Skill {
  /** Stable id, e.g. "bitrefill" / "portfolio-manager". */
  name: string;
  /**
   * "When to use this" — the spec's selection signal. May be long and embed the
   * trigger phrases ("…Triggers when the user mentions gift cards, eSIM…").
   */
  description: string;
  /** The playbook: markdown instructions injected into the system prompt. */
  instructions: string;
  /**
   * Tool names this skill is allowed to use. When set, the engine exposes only
   * these tools while the skill is active (progressive disclosure). Omit to
   * allow all registered tools (the default for capability-routing skills).
   */
  tools?: string[];
  /** Optional trigger keywords to boost selection (in addition to description). */
  triggers?: string[];
  /** Remaining frontmatter (compatibility, author, version, homepage, …). */
  metadata?: Record<string, string>;
  /** Reference files (references/*.md) for progressive disclosure. */
  references?: SkillReference[];
  /** Source folder, when loaded from disk (Node). */
  dir?: string;
}

/** Picks the most relevant skill for a query (or null for none). */
export interface SkillSelector {
  select(query: string, skills: Skill[]): Skill | null;
}
