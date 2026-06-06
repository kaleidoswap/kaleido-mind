/**
 * Tool-use benchmark — run "classic" user requests through the full agent
 * (skills + tools) and grade skill routing + tool selection, saving a JSONL log
 * (fine-tuning data + hackathon evidence) to ~/.kaleido/mind/logs/.
 *
 * Grades the agentic capability that matters on small models: did it route to
 * the right skill and call the right tool? (Per our benchmarks, tiny models
 * nail tool *selection* even when argument-following is weaker.)
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MIND_DIR } from './config.js';
import { c, table, bytes } from './ui.js';
import { agentTurn, type Agent } from './chat.js';

export interface BenchCase {
  id: string;
  prompt: string;
  /** Expected skill name (or undefined = don't check). */
  expectSkill?: string;
  /** Expected tool the agent should call (or undefined = don't check). */
  expectTool?: string;
}

/** Classic things a wallet user actually asks. */
export const SUITE: BenchCase[] = [
  { id: 'balance', prompt: "what's my balance?", expectSkill: 'kaleido-wallet', expectTool: 'wdk_get_balances' },
  { id: 'receive', prompt: 'give me an address to receive bitcoin', expectSkill: 'kaleido-wallet', expectTool: 'wdk_get_address' },
  { id: 'channels', prompt: 'show my lightning channels', expectSkill: 'kaleido-wallet', expectTool: 'wdk_list_channels' },
  { id: 'node', prompt: 'is my node synced?', expectSkill: 'kaleido-wallet', expectTool: 'wdk_get_node_info' },
  { id: 'price', prompt: "what's the bitcoin price right now?", expectSkill: 'kaleido-trading', expectTool: 'get_price' },
  { id: 'quote', prompt: 'quote me a swap of 0.001 BTC to USDT', expectSkill: 'kaleido-trading', expectTool: 'kaleidoswap_get_quote' },
  { id: 'remember', prompt: 'remember that I prefer receiving on Lightning', expectTool: 'remember' },
  { id: 'recall', prompt: 'what do you remember about my preferences?', expectTool: 'recall' },
  { id: 'giftcard', prompt: 'I want to buy a $25 Amazon gift card with bitcoin', expectSkill: 'bitrefill' },
  { id: 'explain', prompt: 'how do I get inbound liquidity to receive payments?' },
];

interface CaseResult extends BenchCase {
  skill: string | null;
  toolCalls: string[];
  text: string;
  turns: number;
  latencyMs: number;
  skillOk: boolean;
  toolOk: boolean;
  answered: boolean;
  pass: boolean;
}

export async function runBench(agent: Agent, ts: number, opts: { suite?: BenchCase[] } = {}): Promise<void> {
  const suite = opts.suite ?? SUITE;
  console.log(`\n${c.bold('Benchmark')} ${c.dim(`· ${agent.mode} · ${agent.modelLabel} · ${suite.length} classic requests`)}\n`);

  const results: CaseResult[] = [];
  for (const tc of suite) {
    let rep;
    try {
      rep = await agentTurn(agent, tc.prompt, [], { onConfirm: () => true });
    } catch (e) {
      rep = { skill: null, text: `ERROR: ${(e as Error).message}`, toolCalls: [], turns: 0, latencyMs: 0 };
    }
    const toolNames = rep.toolCalls.map((t) => t.name);
    const skillOk = !tc.expectSkill || rep.skill === tc.expectSkill;
    const toolOk = !tc.expectTool || toolNames.includes(tc.expectTool);
    const answered = rep.text.trim().length > 0;
    const pass = skillOk && toolOk && answered;
    const r: CaseResult = { ...tc, skill: rep.skill, toolCalls: toolNames, text: rep.text, turns: rep.turns, latencyMs: rep.latencyMs, skillOk, toolOk, answered, pass };
    results.push(r);
    console.log(
      `  ${pass ? c.green('✓') : c.red('✗')} ${c.bold(tc.id.padEnd(9))} ` +
        `${c.dim('skill')} ${skillOk ? c.green(rep.skill ?? '∅') : c.red(`${rep.skill ?? '∅'}≠${tc.expectSkill}`)}  ` +
        `${c.dim('tool')} ${tc.expectTool ? (toolOk ? c.green(tc.expectTool) : c.red(`✗ got [${toolNames.join(',') || '∅'}]`)) : c.dim(toolNames.join(',') || '—')}  ` +
        `${c.dim(`${Math.round(rep.latencyMs)}ms`)}`,
    );
  }

  const passed = results.filter((r) => r.pass).length;
  const toolPass = results.filter((r) => r.toolOk).length;
  const skillPass = results.filter((r) => r.skillOk).length;
  const avg = Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / results.length);

  console.log('');
  const pc = passed === results.length ? c.green : c.yellow;
  console.log(
    table([
      [c.dim('overall'), pc(`${passed}/${results.length} pass`)],
      [c.dim('skill routing'), `${skillPass}/${results.length}`],
      [c.dim('tool selection'), `${toolPass}/${results.length}`],
      [c.dim('avg latency'), `${avg}ms`],
    ]),
  );

  // Save JSONL log (one record per case) — fine-tuning data + evidence bundle.
  const logsDir = join(MIND_DIR, 'logs');
  await mkdir(logsDir, { recursive: true });
  const file = join(logsDir, `bench-${ts}.jsonl`);
  const lines = results.map((r) =>
    JSON.stringify({
      ts,
      model: agent.modelLabel,
      mode: agent.mode,
      id: r.id,
      prompt: r.prompt,
      expect: { skill: r.expectSkill, tool: r.expectTool },
      got: { skill: r.skill, toolCalls: r.toolCalls, text: r.text, turns: r.turns, latencyMs: r.latencyMs },
      grade: { skillOk: r.skillOk, toolOk: r.toolOk, answered: r.answered, pass: r.pass },
    }),
  );
  await writeFile(file, lines.join('\n') + '\n');
  console.log(`\n${c.green('✓')} saved ${results.length} records → ${c.dim(file)} ${c.dim(`(${bytes(Buffer.byteLength(lines.join('\n')))})`)}\n`);
}
