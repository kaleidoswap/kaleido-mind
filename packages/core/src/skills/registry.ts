/**
 * SkillRegistry — holds skills, parses SKILL.md files, selects per query, and
 * composes the system prompt for the selected skill.
 *
 * Selection is pluggable. The default is a fast keyword heuristic (no model
 * call); a host can inject a model-driven or embedding selector instead.
 */

import type { Skill, SkillSelector } from './types.js';

/**
 * Parse a SKILL.md file: a YAML-ish frontmatter block (name/description/tools/
 * triggers) followed by the instruction body.
 *
 *   ---
 *   name: portfolio-manager
 *   description: Rebalance BTC/USDT/XAUT to target allocations.
 *   tools: get_balance, kaleidoswap_get_quote, kaleidoswap_place_order
 *   triggers: rebalance, allocation, portfolio
 *   ---
 *   <instructions…>
 */
export function parseSkill(markdown: string): Skill {
  const fm = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  let body = markdown;
  if (fm) {
    body = fm[2] ?? '';
    for (const line of (fm[1] ?? '').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_]+)\s*:\s*(.+?)\s*$/);
      if (m && m[1]) meta[m[1].toLowerCase()] = m[2] ?? '';
    }
  }
  const list = (v?: string) =>
    v
      ? v.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

  if (!meta.name) throw new Error('SKILL.md missing `name` in frontmatter');
  return {
    name: meta.name,
    description: meta.description ?? '',
    instructions: body.trim(),
    tools: list(meta.tools),
    triggers: list(meta.triggers),
  };
}

// Common words that shouldn't count toward a skill match.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'what', 'this', 'that', 'with', 'from',
  'have', 'has', 'are', 'was', 'can', 'will', 'please', 'today', 'now', 'get',
  'show', 'tell', 'how', 'much', 'many', 'about', 'into', 'over',
]);

/** Default selector: score by meaningful keyword overlap; triggers weigh most. */
export const keywordSelector: SkillSelector = {
  select(query, skills) {
    const q = query.toLowerCase();
    const words = new Set(
      q.split(/\W+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)),
    );
    let best: Skill | null = null;
    let bestScore = 0;
    for (const skill of skills) {
      const haystack = `${skill.description} ${(skill.triggers ?? []).join(' ')}`.toLowerCase();
      const hayWords = haystack.split(/\W+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
      let score = 0;
      for (const w of hayWords) if (words.has(w)) score += 1;
      // Strong boost for an explicit trigger appearing in the query.
      for (const t of skill.triggers ?? []) if (q.includes(t.toLowerCase())) score += 3;
      if (score > bestScore) {
        bestScore = score;
        best = skill;
      }
    }
    // Require a real signal, not a single incidental word overlap.
    return bestScore >= 2 ? best : null;
  },
};

export class SkillRegistry {
  private readonly skills: Skill[] = [];
  private readonly selector: SkillSelector;

  constructor(skills: Skill[] = [], selector: SkillSelector = keywordSelector) {
    this.skills = [...skills];
    this.selector = selector;
  }

  add(skill: Skill): this {
    this.skills.push(skill);
    return this;
  }

  /** Add a skill from raw SKILL.md text. */
  addMarkdown(markdown: string): this {
    return this.add(parseSkill(markdown));
  }

  list(): Skill[] {
    return [...this.skills];
  }

  get(name: string): Skill | undefined {
    return this.skills.find((s) => s.name === name);
  }

  /** Pick the most relevant skill for a query (null = none). */
  select(query: string): Skill | null {
    return this.selector.select(query, this.skills);
  }

  /**
   * Compose the effective system prompt for a skill: the base prompt + the
   * skill's playbook. The returned `allowedTools` should be passed to
   * `engine.runAgentic(..., { allowedTools })` for progressive tool disclosure.
   */
  compose(base: string, skill: Skill | null): { system: string; allowedTools?: string[] } {
    if (!skill) return { system: base };
    const system = `${base}\n\n## Active skill: ${skill.name}\n${skill.instructions}`.trim();
    return { system, allowedTools: skill.tools };
  }
}
