/**
 * buildTaskPrompt — turns an AgentTask into the instruction the agent runs on
 * each scheduled fire. Port of kaleidoagent's nanobot-cron-sync.buildCronPrompt,
 * de-nanobot'd: it targets the Funnel's skill-scoped agentic tier directly, so a
 * host typically does `funnel.runTurn(buildTaskPrompt(task, opts), { ... })`.
 *
 * The strict-JSON return contract is preserved so the host can parse a run's
 * action/portfolio summary back out (the RunLog stores the raw text; a host that
 * wants structured snapshots parses the JSON).
 */

import type { AgentTask } from './types.js';

export interface TaskPromptOptions {
  /** Clock — injectable for deterministic tests. Default: Date.now via new Date. */
  nowIso?: string;
  /** True forbids any live wallet action (passed through to the model + enforced by risk). */
  dryRun: boolean;
  /** Portfolio targets / risk params / allocations surfaced to the model. */
  params?: Record<string, unknown>;
}

export function buildTaskPrompt(task: AgentTask, opts: TaskPromptOptions): string {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const params = {
    allocation: task.allocation,
    ...opts.params,
  };
  return [
    'You are operating as the KaleidoSwap autonomous background runtime.',
    `Current time: ${nowIso}`,
    `Task id: ${task.id}`,
    `Task: ${task.name} — ${task.description}`,
    `Primary skill: ${task.skill}`,
    `dry_run: ${opts.dryRun}`,
    `Parameters: ${JSON.stringify(params)}`,
    '',
    `Use the "${task.skill}" skill to complete this task with the available tools.`,
    'Fetch every value (balances, quotes, asset ids) live from tools — never invent one.',
    opts.dryRun
      ? 'dry_run is ON: describe what you WOULD do. Do NOT pay, send, swap, or open channels.'
      : 'Respect the fund-safety limits: never breach the BTC reserve or stop-loss floor.',
    'Return STRICT JSON only, no prose, with these fields:',
    '{"task":"' + task.id + '","timestamp":"ISO8601","action":"...","dry_run":' +
      String(opts.dryRun) +
      ',"reason":"...","details":{}}',
  ].join('\n');
}
