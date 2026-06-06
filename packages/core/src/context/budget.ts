/**
 * Context budgeting — the hardware-aware part.
 *
 * Small on-device models have small context windows (a 0.6B may run at 2k, a
 * desktop 8B at 8k+). Memory, skills, RAG and tool schemas all compete for that
 * window. These helpers turn a model's `ctx_size` into a token budget for the
 * injected context, so we never overflow a tiny model.
 *
 * Token estimation is deliberately rough (≈ 4 chars/token) — no tokenizer dep.
 */

/** Rough token count for a string (no tokenizer — ~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Trim text to at most `maxTokens` (on a word boundary where possible). */
export function clampToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const sp = cut.lastIndexOf(' ');
  return (sp > maxChars * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

export interface BudgetReserves {
  /** Tokens to leave for the model's reply. Default 512. */
  output?: number;
  /** Tokens to budget for tool schemas the engine sends. Default 600. */
  tools?: number;
  /** Tokens to budget for the running conversation (user + history). Default 768. */
  conversation?: number;
}

/**
 * Tokens available for the *injected system context* (soul + instructions +
 * skill + memory + RAG), given the model's context window and what else must
 * fit. Never negative; clamped to a sane floor so something always gets in.
 */
export function contextBudgetTokens(ctxSize: number, reserves: BudgetReserves = {}): number {
  const output = reserves.output ?? 512;
  const tools = reserves.tools ?? 600;
  const conversation = reserves.conversation ?? 768;
  const available = ctxSize - output - tools - conversation;
  return Math.max(256, available);
}
