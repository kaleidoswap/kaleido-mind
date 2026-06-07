/**
 * Recipe runner — executes a Recipe with ONE structured extraction (or a
 * deterministic regex), then runs the deterministic step chain and the
 * confirmation-gated final action. This is mobile multi-step: a tiny model
 * fills slots; the engine does the planning.
 */

import type { LLMProvider } from '../providers/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ConfirmDecision } from '../types.js';
import type { Recipe, RecipeContext, RecipeResult } from './types.js';

const EXTRACT_TOOL = 'extract_request';

export interface RunRecipeOptions {
  provider: LLMProvider;
  tools: ToolRegistry;
  /** Called before the (spend) final action when its tool is confirmation-gated. */
  onConfirm?: (call: { name: string; arguments: Record<string, unknown> }) => Promise<ConfirmDecision>;
  /** Progress hook per completed step. */
  onStep?: (name: string, args: Record<string, unknown>, result: unknown) => void;
  /** Skip extraction and use these slots (deterministic Tier-0 / tests). */
  slots?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** Extract the recipe's slots — deterministic regex first, else ONE LLM call. */
export async function extractSlots(
  provider: LLMProvider,
  recipe: Recipe,
  text: string,
): Promise<{ slots: Record<string, unknown>; inferences: number }> {
  const det = recipe.extract?.(text);
  if (det && Object.values(det).some((v) => v !== undefined && v !== null && v !== '')) {
    return { slots: det, inferences: 0 };
  }
  const properties: Record<string, { type: string; description: string }> = {};
  for (const s of recipe.slots) properties[s.name] = { type: s.type ?? 'string', description: s.description };
  const extractTool = {
    name: EXTRACT_TOOL,
    description: `Extract the fields from the user's request.`,
    parameters: { type: 'object', properties, required: recipe.slots.filter((s) => s.required).map((s) => s.name) },
  };
  const out = await provider.runTurn({
    system: `Call ${EXTRACT_TOOL} with the fields from the user's message. Do not call any other tool and do not add commentary.`,
    messages: [{ role: 'user', content: text }],
    tools: [extractTool],
  });
  const call = out.toolCalls?.find((c) => c.name === EXTRACT_TOOL) ?? out.toolCalls?.[0];
  return { slots: (call?.arguments as Record<string, unknown>) ?? {}, inferences: 1 };
}

/** Run a recipe end to end. Never throws — failures come back as status:'error'. */
export async function runRecipe(recipe: Recipe, text: string, opts: RunRecipeOptions): Promise<RecipeResult> {
  const ctx: RecipeContext = { text, slots: opts.slots ?? {}, results: {} };
  let inferences = 0;
  try {
    if (!opts.slots) {
      const ex = await extractSlots(opts.provider, recipe, text);
      ctx.slots = ex.slots;
      inferences = ex.inferences;
    }

    // Deterministic steps.
    for (const step of recipe.steps) {
      if (step.skipIf?.(ctx)) continue;
      const args = step.args(ctx);
      const result = await opts.tools.execute(step.tool, args);
      ctx.results[step.as ?? step.tool] = result;
      opts.onStep?.(step.tool, args, result);
    }

    // Final action — confirmation-gated if the tool requires it.
    const finalArgs = recipe.final.args(ctx);
    const def = await opts.tools.getDef(recipe.final.tool);
    if (def?.requiresConfirmation && opts.onConfirm) {
      const decision = await opts.onConfirm({ name: recipe.final.tool, arguments: finalArgs });
      if (!decision.approved) {
        return { recipe: recipe.name, slots: ctx.slots, results: ctx.results, text: 'Cancelled — nothing was sent.', status: 'cancelled', inferences };
      }
    }
    const finalResult = await opts.tools.execute(recipe.final.tool, finalArgs);
    ctx.results[recipe.final.as ?? recipe.final.tool] = finalResult;
    opts.onStep?.(recipe.final.tool, finalArgs, finalResult);

    const out = recipe.summary?.(ctx, finalResult) ?? 'Done.';
    return { recipe: recipe.name, slots: ctx.slots, results: ctx.results, final: finalResult, text: out, status: 'done', inferences };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    return { recipe: recipe.name, slots: ctx.slots, results: ctx.results, text: `Couldn't complete that: ${msg}`, status: 'error', error: msg, inferences };
  }
}

/** Selects a recipe for a request. Use before falling back to the free agentic loop. */
export class RecipeRegistry {
  private recipes: Recipe[];
  constructor(recipes: Recipe[] = []) {
    this.recipes = [...recipes];
  }
  add(recipe: Recipe): void {
    this.recipes.push(recipe);
  }
  list(): Recipe[] {
    return [...this.recipes];
  }
  get(name: string): Recipe | undefined {
    return this.recipes.find((r) => r.name === name);
  }
  /** First recipe whose match()/triggers fit the text, else null. */
  select(text: string): Recipe | null {
    const lc = text.toLowerCase();
    return (
      this.recipes.find((r) =>
        r.match ? r.match(text) : (r.triggers ?? []).some((t) => lc.includes(t.toLowerCase())),
      ) ?? null
    );
  }
}
