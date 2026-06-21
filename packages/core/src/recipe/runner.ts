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
  /**
   * Called before a confirmation-gated spend. `summary` is set when the recipe
   * supplies a `confirm(ctx)` — a human-readable description of the whole
   * approved action (e.g. "swap 10 USDT → 15,250 sats, fee 154 sats"). Hosts
   * should prefer `summary` over the raw tool name/args when showing a sheet.
   */
  onConfirm?: (call: { name: string; arguments: Record<string, unknown>; summary?: string }) => Promise<ConfirmDecision>;
  /** Progress hook per completed step. */
  onStep?: (name: string, args: Record<string, unknown>, result: unknown) => void;
  /** Skip extraction and use these slots (deterministic Tier-0 / tests). */
  slots?: Record<string, unknown>;
  signal?: AbortSignal;
}

function toolFailure(result: unknown): string | null {
  // A plain-string result (non-JSON MCP text, or a tool that returns prose):
  // flag obvious error text so a failed action isn't reported as success.
  if (typeof result === 'string') {
    const s = result.trim();
    return /^(error|failed|failure|exception)\b\s*[:\-]?/i.test(s) ? s : null;
  }
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (typeof r.error === 'string' && r.error.trim()) return r.error;
  if (r.success === false || r.ok === false) {
    return String(r.message ?? r.reason ?? 'The wallet action failed.');
  }
  const status = String(r.status ?? r.state ?? '').toLowerCase();
  if (['error', 'failed', 'failure', 'rejected'].includes(status)) {
    return String(r.message ?? r.reason ?? `The wallet returned status "${status}".`);
  }
  return null;
}

function failedResult(
  recipe: Recipe,
  ctx: RecipeContext,
  inferences: number,
  message: string,
): RecipeResult {
  return {
    recipe: recipe.name,
    slots: ctx.slots,
    results: ctx.results,
    text: `Couldn't complete that: ${message}`,
    status: 'error',
    error: message,
    inferences,
  };
}

/** Extract the recipe's slots — deterministic regex first, else ONE LLM call. */
export async function extractSlots(
  provider: LLMProvider,
  recipe: Recipe,
  text: string,
): Promise<{ slots: Record<string, unknown>; inferences: number }> {
  const det = recipe.extract?.(text);
  const detValid = det && Object.values(det).some((v) => v !== undefined && v !== null && v !== '');

  if (detValid && !recipe.forceModelExtract) {
    return { slots: det, inferences: 0 };
  }

  // Build a richer extraction prompt + tool schema so small models have a
  // better chance of producing correct structured output for recipes (especially
  // when forceModelExtract is on for natural language intents like "buy 1 usdt").
  const properties: Record<string, { type: string; description: string }> = {};
  for (const s of recipe.slots) properties[s.name] = { type: s.type ?? 'string', description: s.description };

  const recipeHint = recipe.description ? ` for the "${recipe.name}" recipe (${recipe.description})` : '';
  const extractTool = {
    name: EXTRACT_TOOL,
    description: `Extract the fields from the user's request${recipeHint}.`,
    parameters: { type: 'object', properties, required: recipe.slots.filter((s) => s.required).map((s) => s.name) },
  };

  const system = [
    `Call ${EXTRACT_TOOL} with the fields from the user's message.`,
    recipe.description ? `This extraction is for: ${recipe.description}.` : '',
    'Only emit values that match the field descriptions. Use the examples and phrasings listed in each field\'s description (including context like "on the other" when "my side" appears).',
    'Canonical assets: BTC, USDT, XAUT (pass as strings like "BTC" or "USDT").',
    'amount_side: "to" when the named amount is what you receive/buy (e.g. "buy 1 USDT" → to_asset=USDT, amount=1, from_asset=BTC); "from" for sell/swap (amount on from_asset).',
    'The host binding handles per-asset precision scaling (BTC in sats → maker units; USDT/XAUT whole units). Pass the user\'s number as-is for the correct side.',
    'If a value is ambiguous from the message, prefer the mapping from the field descriptions rather than guessing.',
    'For status-related follow-ups the history (or recall result) will contain explicit "order_id=... access_token=..." or "atomic_id=..." strings from prior summaries — when relevant extract them exactly.',
    'Do not call any other tool and do not add commentary.',
  ].filter(Boolean).join(' ');

  const out = await provider.runTurn({
    system,
    messages: [{ role: 'user', content: text }],
    tools: [extractTool],
  });

  const call = out.toolCalls?.find((c) => c.name === EXTRACT_TOOL) ?? out.toolCalls?.[0];
  let llmSlots: Record<string, unknown> = (call?.arguments as Record<string, unknown>) ?? {};

  // Safety net when forceModelExtract is active.
  // - The LLM is authoritative for the slots it filled — its output wins.
  // - Det is used only to backfill required fields the LLM left empty.
  // - The amount_side-specific check below applies ONLY to recipes that
  //   actually declare an `amount_side` slot (swap-shaped recipes) — for
  //   others (channel-order, etc.) it would clobber correct LLM extraction
  //   because amount_side is always undefined.
  if (recipe.forceModelExtract && detValid) {
    const required = recipe.slots.filter((s) => s.required);
    const llmHasAllRequired = required.every((s) => {
      const v = llmSlots[s.name];
      return v != null && v !== '';
    });

    const recipeHasAmountSide = recipe.slots.some((s) => s.name === 'amount_side');
    if (recipeHasAmountSide) {
      const llmSide = String(llmSlots.amount_side || '').toLowerCase();
      const validSide = llmSide === 'from' || llmSide === 'to';
      if (!llmHasAllRequired || !validSide) {
        llmSlots = { ...det, ...llmSlots };
      } else {
        llmSlots.amount_side = llmSide;
      }
      if (!validSide && det.amount_side) {
        llmSlots.amount_side = det.amount_side;
      }
    } else {
      // Generic path: backfill ANY slot the LLM didn't populate from det's
      // value, when det has one. LLM wins on every field it actually filled,
      // but det shouldn't be silently erased — small models often omit
      // non-required slots (e.g. asset_ticker on a USDT channel) that the
      // deterministic regex caught reliably.
      for (const s of recipe.slots) {
        const llmVal = llmSlots[s.name];
        const detVal = det[s.name];
        if ((llmVal == null || llmVal === '') && detVal != null && detVal !== '') {
          llmSlots[s.name] = detVal;
        }
      }
    }
  }

  return { slots: llmSlots, inferences: 1 };
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

    // Confidence re-check AFTER extraction (whether deterministic, LLM, or
    // pre-supplied). When the recipe defines `confident()` and the extracted
    // slots fail it, refuse to run the steps with bad data — surface a
    // friendly "please specify <missing required slots>" message so the user
    // can re-ask with the info instead of getting a maker 4xx mid-chain.
    if (recipe.confident && !recipe.confident(ctx.slots)) {
      const missing = recipe.slots
        .filter((s) => s.required && (ctx.slots[s.name] == null || ctx.slots[s.name] === ''))
        .map((s) => s.name);
      const ask =
        missing.length > 0
          ? `I need a bit more info — please specify the ${missing.join(' and ')} (rephrase with the numbers, or use recall if this is a follow-up status check).`
          : "I don't have enough info to do that — could you rephrase with the specifics?";
      return { recipe: recipe.name, slots: ctx.slots, results: ctx.results, text: ask, status: 'needs-info', inferences };
    }

    // Confirmation model:
    //  - Recipe with `confirm(ctx)`: fire ONE gate before the first spend step,
    //    showing the recipe-level summary; once approved, later spend steps run
    //    ungated (the whole chain is one approved decision).
    //  - Recipe without `confirm`: gate EACH spend tool individually (default;
    //    payments/receive/asset-send rely on this).
    // Missing onConfirm FAILS CLOSED in both cases, matching the Engine.
    const cancelled = (): RecipeResult => ({
      recipe: recipe.name, slots: ctx.slots, results: ctx.results,
      text: 'Cancelled — nothing was sent.', status: 'cancelled', inferences,
    });
    let recipeApproved = false;

    /** Gate a single (spend) step. Returns false if the user declined. */
    const passesGate = async (toolName: string, args: Record<string, unknown>): Promise<boolean> => {
      const def = await opts.tools.getDef(toolName);
      if (!def?.requiresConfirmation) return true;
      // Recipe-level single confirm: ask once, then remember the approval.
      if (recipe.confirm) {
        if (recipeApproved) return true;
        const summary = recipe.confirm(ctx) ?? undefined;
        const decision = opts.onConfirm
          ? await opts.onConfirm({ name: toolName, arguments: args, summary })
          : { approved: false, reason: 'no confirmation handler available' };
        if (decision.approved) recipeApproved = true;
        return decision.approved;
      }
      // Per-tool confirm (legacy default).
      const decision = opts.onConfirm
        ? await opts.onConfirm({ name: toolName, arguments: args })
        : { approved: false, reason: 'no confirmation handler available' };
      return decision.approved;
    };

    for (const step of recipe.steps) {
      if (step.skipIf?.(ctx)) continue;
      const args = step.args(ctx);
      if (!(await passesGate(step.tool, args))) return cancelled();
      const result = await opts.tools.execute(step.tool, args);
      ctx.results[step.as ?? step.tool] = result;
      opts.onStep?.(step.tool, args, result);
      const failure = toolFailure(result);
      if (failure) return failedResult(recipe, ctx, inferences, failure);
    }

    // Final action.
    const finalArgs = recipe.final.args(ctx);
    if (!(await passesGate(recipe.final.tool, finalArgs))) return cancelled();
    const finalResult = await opts.tools.execute(recipe.final.tool, finalArgs);
    ctx.results[recipe.final.as ?? recipe.final.tool] = finalResult;
    opts.onStep?.(recipe.final.tool, finalArgs, finalResult);
    const failure = toolFailure(finalResult);
    if (failure) return failedResult(recipe, ctx, inferences, failure);

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
