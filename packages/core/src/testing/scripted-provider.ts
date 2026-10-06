/**
 * A scripted LLMProvider — replays planned turns instead of running a model.
 *
 * Lets hosts wire the full Engine / Funnel (skills, recipes, confirm gate) in
 * unit tests, CI and demos without loading a QVAC model. Deterministic tiers
 * (fast-path, recipes with regex extraction) never call it at all.
 */

import type { ToolCall } from '../types.js';
import type { LLMProvider } from '../providers/types.js';

export interface ScriptedTurn {
  /** Assistant text for this turn. */
  text?: string;
  /** Tool to call — ignored when the tool is not in the turn's scoped tool list. */
  tool?: string;
  args?: Record<string, unknown>;
}

export function scriptedProvider(turns: ScriptedTurn[] = [], fallback = 'I need more information.'): LLMProvider {
  let index = 0;
  return {
    name: 'scripted',
    async runTurn(input) {
      const planned = turns[index++] ?? { text: fallback };
      const call: ToolCall | undefined = planned.tool && input.tools.some((t) => t.name === planned.tool)
        ? { id: `scripted-${index}`, name: planned.tool, arguments: planned.args ?? {} }
        : undefined;
      return {
        text: planned.text ?? '',
        rawContent: planned.text ?? '',
        toolCalls: call ? [call] : [],
        inference: { durationMs: 0, status: 'completed' },
      };
    },
  };
}
