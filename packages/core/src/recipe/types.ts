/**
 * Recipes — multi-step that works on a tiny model. "Recipes, not planning."
 *
 * A small model can't reliably PLAN a chain ("pay bob 3 EUR" = resolve → price
 * → convert → send) from scratch. So a Recipe carries the plan; the model is
 * used for ONE thing — extracting the request's slots (recipient, amount, …).
 * The engine then runs the deterministic steps and the (confirmation-gated)
 * final action. ~1 inference instead of 5; reliable on 0.6–4B.
 *
 * Pure data + interfaces — no deps. The provider + tools are injected.
 */

export interface RecipeSlot {
  name: string;
  type?: 'string' | 'number' | 'boolean';
  description: string;
  required?: boolean;
}

export interface RecipeContext {
  /** The original user text. */
  text: string;
  /** Extracted slots (deterministic regex, else one LLM call). */
  slots: Record<string, unknown>;
  /** Results of completed steps, keyed by `as` (or tool name). */
  results: Record<string, unknown>;
}

export interface RecipeStep {
  /** Tool to call. */
  tool: string;
  /** Build the tool args from the accumulated context. */
  args: (ctx: RecipeContext) => Record<string, unknown>;
  /** Store the result under this key (default: the tool name). */
  as?: string;
  /** Skip this step when true (e.g. recipient is already an address). */
  skipIf?: (ctx: RecipeContext) => boolean;
}

export interface Recipe {
  name: string;
  description?: string;
  /** Selection: a predicate or trigger phrases. */
  match?: (text: string) => boolean;
  triggers?: string[];
  /** Fields the model (or regex) extracts from the request. */
  slots: RecipeSlot[];
  /** Optional deterministic extractor tried BEFORE the LLM (Tier-0 fast-path). */
  extract?: (text: string) => Record<string, unknown> | null;
  /**
   * When true (and `extract` is provided), the runner will *ignore* a successful
   * deterministic extraction and always perform the 1-inference LLM slot
   * extraction. This lets the model do the natural-language understanding of
   * the user's request (e.g. "buy 1 usdt") while the Recipe still owns the
   * reliable multi-step execution plan and single-confirmation safety.
   */
  forceModelExtract?: boolean;
  /**
   * Whether the recipe is confident enough to RUN deterministically given the
   * extracted slots (vs falling back to the agentic loop). e.g. payments needs a
   * recipient; receive needs an amount or asset. Default: any slot extracted.
   */
  confident?: (slots: Record<string, unknown>) => boolean;
  /** Deterministic steps, run in order, results threaded into `ctx`. */
  steps: RecipeStep[];
  /** The terminal action (usually a spend → confirmation-gated by its tool). */
  final: RecipeStep;
  /** Render the outcome for the user. */
  summary?: (ctx: RecipeContext, finalResult: unknown) => string;
  /**
   * Single recipe-level confirmation. When set, the runner fires exactly ONE
   * confirmation gate immediately before the first spend step, passing the
   * returned string as the confirm summary; once approved, the remaining spend
   * steps run WITHOUT re-prompting (the whole chain is one approved decision).
   *
   * Use for multi-spend chains where the user makes a single choice up front
   * from data gathered by earlier (read-only) steps — e.g. an atomic swap:
   * quote first, then confirm "swap X → Y, fee Z" once, then init/whitelist/
   * execute run as a unit.
   *
   * Return `null` to skip confirmation entirely (rare). When `confirm` is
   * absent, the runner falls back to gating EACH spend tool individually
   * (the default — used by payments/receive/asset-send).
   */
  confirm?: (ctx: RecipeContext) => string | null;
}

export type RecipeStatus = 'done' | 'cancelled' | 'error' | 'needs-info';

export interface RecipeResult {
  recipe: string;
  slots: Record<string, unknown>;
  results: Record<string, unknown>;
  final?: unknown;
  text: string;
  status: RecipeStatus;
  error?: string;
  /** Number of LLM inferences used (0 if extraction was deterministic). */
  inferences: number;
}
