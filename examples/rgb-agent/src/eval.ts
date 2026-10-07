/**
 * Live eval: run seven wallet requests through the real Funnel (fast path,
 * recipes, skills, agentic loop) with a local QVAC model, and check each one
 * did the right thing.
 *
 *   pnpm eval:mock              # in-process fake RLN node + local model
 *   pnpm eval                   # kaleido-mcp on signet + local model (issues a test asset)
 *
 * Env:   MODEL   @qvac/sdk model constant (default: QWEN3_5_2B_MULTIMODAL_Q4_K_M)
 *        OPENAI_BASE_URL / OPENAI_MODEL / OPENAI_API_KEY   use an OpenAI-compatible server instead
 *        THINK   reasoning budget in tokens (default: 128)
 *        ONLY    comma-separated scenario ids to run, e.g. ONLY=issue,send
 *        OUT     append one JSON line per scenario to this file
 *        REPEAT  run each scenario this many times and report the pass rate (default 1)
 *
 * Exits 1 when a scenario fails. The issue scenario is approved at the
 * confirmation gate (a real asset on signet); the send is always declined.
 */
import { appendFileSync } from 'node:fs';
import { Funnel, ToolRegistry, type ConfirmDecision } from '@kaleidorg/mind';
import { loadSkillsDir, packagedSkillsDir } from '@kaleidorg/mind/skills';
import { createTools, loadProvider } from './setup.js';

const MOCK = process.argv.includes('--mock') || process.env.MOCK === '1';
const REPEAT = Math.max(1, Number(process.env.REPEAT ?? 1) || 1);

const LIVE_TOOLS = [
  'rln_get_balances', 'rln_get_node_info', 'rln_list_assets', 'rln_get_asset_balance', 'rln_refresh_transfers',
  'rln_create_rgb_invoice', 'rln_send_asset', 'rln_create_utxos', 'rln_issue_asset', 'rln_list_transfers',
  'rln_create_ln_invoice', 'rln_list_channels',
  'kaleidoswap_get_assets', 'kaleidoswap_get_pairs', 'kaleidoswap_get_quote',
];

interface Run {
  text: string;
  tier: string;
  route?: string;
  tools: string[];
  gates: { name: string; summary?: string; approved: boolean }[];
  /** Per model call: time to first token, duration, prompt tokens. */
  inference?: { ttftMs?: number; durationMs: number; promptTokens?: number }[];
}

interface Scenario {
  id: string;
  prompt: string;
  /** Approve spends at the confirmation gate (default: decline). */
  approve?: boolean;
  liveOnly?: boolean;
  /** Returns a failure reason, or null when the run did the right thing. */
  check: (r: Run) => string | null;
}

const ticker = `E${Date.now().toString(36).slice(-4).toUpperCase()}`;
const called = (r: Run, ...names: string[]) => names.some((n) => r.tools.includes(n) || r.gates.some((g) => g.name === n));
const need = (ok: boolean, reason: string) => (ok ? null : reason);

const SCENARIOS: Scenario[] = [
  {
    id: 'balance',
    prompt: 'What is my on-chain BTC balance?',
    check: (r) => need(r.tier === 'fast' || called(r, 'rln_get_balances'), 'no balance read') ?? need(/\d/.test(r.text), 'no amount in the answer'),
  },
  {
    id: 'assets',
    prompt: 'Which RGB assets do I hold, and what are the balances?',
    check: (r) =>
      need(r.tier === 'fast' || called(r, 'rln_list_assets', 'rln_get_asset_balance'), 'assets not listed') ??
      need(!/\d\s*(satoshis|sats?)\b/i.test(r.text), 'asset balances labelled as sats'),
  },
  {
    id: 'issue',
    prompt: `Issue a new fungible RGB token named Eval ${ticker} with ticker ${ticker}, total supply 1000000 and precision 0.`,
    approve: true,
    check: (r) =>
      need(called(r, 'rln_issue_asset'), 'rln_issue_asset not called') ??
      need(!r.gates.some((g) => /NaN/.test(g.summary ?? '')), 'NaN in the confirmation readback'),
  },
  {
    id: 'rgb-invoice',
    prompt: `Create an RGB invoice so I can receive 10 ${MOCK ? 'USDT' : ticker}.`,
    check: (r) => need(called(r, 'rln_create_rgb_invoice'), 'rln_create_rgb_invoice not called') ?? need(/rgb:/.test(r.text), 'no RGB invoice in the answer'),
  },
  {
    id: 'ln-invoice',
    prompt: 'Create a Lightning invoice for 5000 sats.',
    check: (r) => need(called(r, 'rln_create_ln_invoice'), 'rln_create_ln_invoice not called'),
  },
  {
    id: 'quote',
    prompt: 'Get a quote to swap 0.0005 BTC into USDT on KaleidoSwap.',
    liveOnly: true,
    check: (r) => need(called(r, 'kaleidoswap_get_quote'), 'kaleidoswap_get_quote not called'),
  },
  {
    id: 'send',
    prompt: `Send 1 ${MOCK ? 'USDT' : ticker} to this RGB invoice: rgb:~/~/~/sig/any/1/utxob:test-recipient`,
    check: (r) =>
      need(r.gates.some((g) => g.name === 'rln_send_asset'), 'send never reached the confirmation gate') ??
      need(/cancel|declin|not sent|nothing was sent/i.test(r.text), 'answer does not say the send was cancelled'),
  },
];

const only = process.env.ONLY?.split(',').map((s) => s.trim());
const scenarios = SCENARIOS.filter((s) => (!s.liveOnly || !MOCK) && (!only || only.includes(s.id)));

const tools = await createTools({ mock: MOCK, allow: LIVE_TOOLS });
const { provider, dispose } = await loadProvider();
let failures = 0;
try {
  const funnel = new Funnel({
    provider,
    tools: new ToolRegistry([tools.source]),
    skills: loadSkillsDir(packagedSkillsDir()),
    compressToolOutput: true,
  });

  const passes = new Map<string, number>();
  for (const s of scenarios) for (let rep = 1; rep <= REPEAT; rep++) {
    const run: Run = { text: '', tier: '', tools: [], gates: [] };
    const started = Date.now();
    let error = '';
    try {
      const res = await funnel.runTurn(s.prompt, {
        onToolCall: (c) => run.tools.push(c.name),
        onStep: (name) => run.tools.push(name),
        onConfirm: async (c): Promise<ConfirmDecision> => {
          run.gates.push({ name: c.name, summary: c.summary, approved: !!s.approve });
          return s.approve ? { approved: true } : { approved: false, reason: 'declined by the eval' };
        },
      });
      Object.assign(run, {
        text: res.text,
        tier: res.tier,
        route: res.route,
        inference: res.inference?.map((i) => ({ ttftMs: i.ttftMs, durationMs: i.durationMs, promptTokens: i.promptTokens })),
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const failure = error ? `error: ${error}` : s.check(run);
    if (failure) failures += 1;
    else passes.set(s.id, (passes.get(s.id) ?? 0) + 1);
    const seconds = +((Date.now() - started) / 1000).toFixed(1);
    console.log(`${failure ? 'FAIL' : 'PASS'}  ${s.id.padEnd(12)} ${String(seconds).padStart(6)}s  ${run.tier}${run.route ? `/${run.route}` : ''}  [${run.tools.join(', ')}]${failure ? `  — ${failure}` : ''}`);
    if (process.env.OUT) {
      appendFileSync(
        process.env.OUT,
        JSON.stringify({ model: process.env.OPENAI_MODEL ?? process.env.MODEL ?? 'QWEN3_5_2B_MULTIMODAL_Q4_K_M', mock: MOCK, id: s.id, rep, pass: !failure, failure, seconds, ...run, text: run.text.slice(0, 600) }) + '\n',
      );
    }
  }
  if (REPEAT > 1) {
    console.log('\npass rate per scenario:');
    for (const sc of scenarios) console.log(`  ${sc.id.padEnd(12)} ${passes.get(sc.id) ?? 0}/${REPEAT}`);
  }
  const runs = scenarios.length * REPEAT;
  console.log(`\n${runs - failures}/${runs} passed`);
} finally {
  await dispose();
  await tools.close();
}
process.exitCode = failures ? 1 : 0;
