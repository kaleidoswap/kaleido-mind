/**
 * SkillRegistry — holds skills, parses SKILL.md files, selects per query, and
 * composes the system prompt for the selected skill.
 *
 * Selection is pluggable. The default is a fast keyword heuristic (no model
 * call); a host can inject a model-driven or embedding selector instead.
 */

import type { Skill, SkillReference, SkillSelector } from './types.js';
import type { EmbeddingProvider } from '../rag/types.js';
import { cosineSimilarity } from '../rag/vector-store.js';

/** Tool name the reference source exposes for progressive disclosure. */
export const READ_REFERENCE_TOOL = 'read_skill_reference';

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
/** Strip wrapping single/double quotes from a frontmatter value. */
function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

export function parseSkill(markdown: string, references?: SkillReference[]): Skill {
  const fm = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  let body = markdown;
  if (fm) {
    body = fm[2] ?? '';
    for (const line of (fm[1] ?? '').split('\n')) {
      // Flat `key: value` lines (incl. indented keys under a nested `metadata:`
      // block, which fold into the same map — we don't need YAML nesting here).
      const m = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/);
      if (m && m[1]) meta[m[1].toLowerCase()] = unquote(m[2] ?? '');
    }
  }
  const list = (v?: string) =>
    v
      ? v.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

  if (!meta.name) throw new Error('SKILL.md missing `name` in frontmatter');

  // Everything that isn't a first-class field becomes metadata.
  const KNOWN = new Set(['name', 'description', 'tools', 'triggers']);
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) if (!KNOWN.has(k)) metadata[k] = v;

  return {
    name: meta.name,
    description: meta.description ?? '',
    instructions: body.trim(),
    tools: list(meta.tools),
    triggers: list(meta.triggers),
    metadata: Object.keys(metadata).length ? metadata : undefined,
    references: references && references.length ? references : undefined,
  };
}

// Common words that shouldn't count toward a skill match.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'what', 'this', 'that', 'with', 'from',
  'have', 'has', 'are', 'was', 'can', 'will', 'please', 'today', 'now', 'get',
  'show', 'tell', 'how', 'much', 'many', 'about', 'into', 'over',
]);

/** Escape a string for safe inclusion in a regex. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match a trigger phrase in the query with WORD BOUNDARIES — so the
 * `usd` trigger on a wallet skill doesn't fire on `usdt`/`usdc`, and
 * `cafe` doesn't fire on `cafeteria`. Multi-word triggers ("near me")
 * still work because spaces are already word boundaries.
 */
function triggerMatches(query: string, trigger: string): boolean {
  const t = trigger.toLowerCase().trim();
  if (!t) return false;
  return new RegExp(`\\b${reEscape(t)}\\b`).test(query);
}

/** Default selector: score by meaningful keyword overlap; triggers weigh most.
 *  Light extra sensitivity for common location / discovery phrasing so merchant-finder
 *  and similar skills surface on natural queries even without exact trigger words.
 */
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
      // Strong boost for an explicit trigger appearing in the query — at a
      // word boundary, so short triggers (`usd`, `eur`, `cafe`) don't leak
      // into longer words (`usdt`, `europe`, `cafeteria`).
      for (const t of skill.triggers ?? []) if (triggerMatches(q, t)) score += 3;

      // Light discovery / location phrase boost (helps merchant-finder and
      // similar skills on natural language like "coffee near the station" or
      // "buy pizza with sats in turin").
      if (/\b(near|nearby|around|close|spend|find|shop|cafe|coffee|food|eat|lunch|dinner|atm|buy|pizz|restaurant)\b/i.test(q)) {
        const skillText = (skill.description + ' ' + (skill.triggers || []).join(' ')).toLowerCase();
        if (/(merchant|btcmap|map|location|nearby|spend.*bitcoin|find.*place|food|restaurant|cafe|eat|pizza)/.test(skillText)) score += 1.5;
      }

      if (score > bestScore) {
        bestScore = score;
        best = skill;
      }
    }
    // Require a real signal, not a single incidental word overlap.
    return bestScore >= 2 ? best : null;
  },
};

/**
 * Optional embedding-powered selector factory.
 *
 * When an EmbeddingProvider (the same shape used by Retriever/RAG) is supplied,
 * hosts can use the returned selector for more semantic skill routing. This
 * helps vague/natural location and discovery queries ("coffee near the station",
 * "somewhere to grab a bite that takes lightning") reach merchant-finder or
 * similar skills even without exact keyword overlap.
 *
 * The current implementation keeps a synchronous SkillSelector contract (to match
 * the existing interface used by Funnel and SkillRegistry). It therefore:
 *   - Uses an enhanced keywordSelector as the fast path (see above).
 *   - If embeddings are provided it is ready for hosts to wrap or evolve into a
 *     fully semantic version (prototype embeddings of skill descriptions +
 *     cosine vs. query, mixed with keyword score).
 *
 * Example host usage (CLI / provider with embeddings already loaded):
 *   import { createEmbeddingSkillSelector, SkillRegistry } from '@kaleidorg/mind';
 *   const selector = createEmbeddingSkillSelector(embeddingsProvider);
 *   const reg = new SkillRegistry(loadedSkills, selector);
 *
 * For a production semantic version a host can implement an async select
 * wrapper around its own Funnel turn or pre-compute skill prototypes.
 */
export function createEmbeddingSkillSelector(
  embeddings?: EmbeddingProvider,
  _opts: { minCosine?: number; keywordFallback?: boolean } = {},
): SkillSelector {
  // Today we return the (already lightly enhanced) keyword selector.
  // The embeddings parameter and factory exist so hosts have a single
  // obvious extension point and the public API signals the intent.
  // A future revision can make SkillSelector support async or add a
  // separate async entry point if the Funnel routing is made async.
  void embeddings; // intentionally unused in the current sync impl
  return keywordSelector;
}

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

  /** Add a skill from raw SKILL.md text (+ optional reference files). */
  addMarkdown(markdown: string, references?: SkillReference[]): this {
    return this.add(parseSkill(markdown, references));
  }

  /** All reference files across skills, tagged with their owning skill. */
  references(): Array<SkillReference & { skill: string }> {
    return this.skills.flatMap((s) =>
      (s.references ?? []).map((r) => ({ ...r, skill: s.name })),
    );
  }

  /** Look up a reference file by name (optionally scoped to one skill). */
  reference(file: string, skill?: string): SkillReference | undefined {
    const base = file.replace(/^references\//, '');
    for (const s of this.skills) {
      if (skill && s.name !== skill) continue;
      const hit = (s.references ?? []).find((r) => r.name === base || r.name === file);
      if (hit) return hit;
    }
    return undefined;
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

    let system = `${base}\n\n## Active skill: ${skill.name}\n${skill.instructions}`.trim();

    // Progressive disclosure: tell the model the reference files exist and how
    // to pull one in, rather than dumping them all into context.
    const refs = skill.references ?? [];
    if (refs.length) {
      const names = refs.map((r) => r.name).join(', ');
      system +=
        `\n\n## Reference files\nThis skill has detailed reference docs: ${names}. ` +
        `When you need the detail for a step, call \`${READ_REFERENCE_TOOL}\` with the ` +
        `filename (e.g. {"file":"${refs[0]!.name}"}) to read it before acting.`;
    }

    // When the skill scopes tools, keep the reference reader reachable too.
    const allowedTools = skill.tools
      ? refs.length
        ? [...skill.tools, READ_REFERENCE_TOOL]
        : skill.tools
      : undefined;
    return { system, allowedTools };
  }
}
