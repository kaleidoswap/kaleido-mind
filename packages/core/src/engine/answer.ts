/**
 * How an agentic run ends: the Engine's fixed replies, and the checks every
 * answer the model wrote goes through before the user sees it.
 *
 * An answer is tagged with where it came from. Fixed replies are final; only
 * model text is rewritten (amount fixes) or replaced (payment data no tool
 * returned). Keeping that rule in one place is what stops a fixed reply that
 * quotes a readback from being mistaken for an invented invoice.
 */
import type { ToolCallError } from '../providers/types.js';
import { findUngroundedPaymentData, fixSatsBtcConversions, ungroundedReply } from '../guards.js';
import { fixRgbBalanceUnits } from '../context/rgb-units.js';

export interface Answer {
  text: string;
  /** `engine`: one of the fixed replies below, never rewritten. */
  source: 'model' | 'engine';
}

export const model = (text: string): Answer => ({ text, source: 'model' });
export const engine = (text: string): Answer => ({ text, source: 'engine' });

export const STOPPED_REPLY = 'I had to stop after several steps — please try a more specific request.';

export const TOOL_CALL_FAILED_REPLY =
  "I couldn't put together a valid request for that. Please rephrase it with the exact values (asset, amount, recipient).";

export const REPEATED_CALL_REPLY = 'I could not get a different result from the wallet — please try a more specific request.';

export function cancelledReply(declined: string[]): string {
  return `Cancelled — you declined: ${declined.join('; ')}. Nothing was sent or changed.`;
}

/** Fed back to the model after a tool call it emitted could not be parsed. */
export function toolErrorFeedback(errors: ToolCallError[], cutOff: boolean): string {
  if (cutOff) {
    return 'Your tool call was cut off because the output got too long. Make ONE tool call at a time with only the required arguments, or answer from the results you already have.';
  }
  const detail = errors.map((e) => e.message).join('; ');
  return `Your tool call could not be read (${detail}). Call the tool again with valid JSON arguments that match its schema, or ask the user for the missing values.`;
}

export interface FinalizeOptions {
  /** Recompute BTC figures and relabel RGB balances. */
  fixAmounts: boolean;
  /** Replace answers carrying payment data no tool returned and the user never typed. */
  guardPaymentData: boolean;
  /** What the answer may legitimately quote: the user's messages and the tool results. */
  sources: unknown[];
  /** Tool results, for relabelling RGB balances. */
  toolResults: unknown[];
  aborted: boolean;
}

/** The text the user sees. */
export function finalizeAnswer(answer: Answer, opts: FinalizeOptions): string {
  if (!answer.text) return opts.aborted ? '' : STOPPED_REPLY;
  if (answer.source === 'engine') return answer.text;
  let text = answer.text;
  if (opts.fixAmounts) text = fixRgbBalanceUnits(fixSatsBtcConversions(text), opts.toolResults);
  if (opts.guardPaymentData) {
    const ungrounded = findUngroundedPaymentData(text, opts.sources);
    if (ungrounded.length) text = ungroundedReply(ungrounded);
  }
  return text;
}
