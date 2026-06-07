/**
 * Eval Track B — multi-step / agentic chains, comparing two execution MODES on
 * the SAME tasks + tools:
 *
 *   recipe  the skill carries the plan; ONE structured extraction (deterministic
 *           here) + the deterministic step chain. ~0 inferences.
 *   free    the model plans every step in a full agentic loop. N inferences.
 *
 * The thesis (from Track A: tiny models are slow + weak at multi-step): recipe
 * resolves ~100% at ~0 inferences, while free-agentic success drops with model
 * size. This harness quantifies that. Execution is STUBBED with chained canned
 * results so it's reproducible; the spend is auto-approved (the confirm gate is
 * framework-enforced — we just assert it fired).
 */

import {
  Engine,
  ToolRegistry,
  bindWalletTools,
  runRecipe,
  paymentsRecipe,
  swapRecipe,
  type LLMProvider,
  type WalletHandler,
  type Recipe,
} from '@kaleidorg/mind';
import { loadProvider, mockEvalProvider } from './run.js';

const RATE_USD = 60000; // stub BTC/USD
const FREE_SYSTEM =
  'You are a wallet assistant. To pay someone: (1) call resolve_contact to get ' +
  'their address, (2) if the amount is in a fiat currency call fiat_to_sats, ' +
  '(3) call send_payment with `to` and `amount_sats`. To swap assets: call ' +
  'get_swap_quote, then execute_swap. Always use tools; never invent a value.';

// ── Stub contract tools (chained canned results) ─────────────────────────────
function stubHandlers(): Record<string, WalletHandler> {
  return {
    resolve_contact: async ({ name }) => ({ name, ln_address: `${String(name).toLowerCase()}@kaleidoswap.com` }),
    get_price: async ({ fiat }) => ({ asset: 'BTC', price_usd: RATE_USD, fiat: fiat ?? 'USD' }),
    fiat_to_sats: async ({ amount }) => ({ sats: Math.round((Number(amount) / RATE_USD) * 1e8) }),
    send_payment: async () => ({ status: 'SUCCESS', payment_hash: 'stub' }),
    get_swap_quote: async ({ from_asset, to_asset, amount }) => ({ quote_id: 'q-stub', from_asset, to_asset, amount: Number(amount), receive_amount: Number(amount) }),
    execute_swap: async () => ({ status: 'SUCCESS', swap_id: 'stub' }),
  };
}
function stubRegistry(): ToolRegistry {
  return new ToolRegistry([bindWalletTools(stubHandlers(), { layers: ['rln', 'core'], allowMissing: true })]);
}

// ── Dataset (seeded, fixed) ──────────────────────────────────────────────────
export interface MultiCase {
  id: string;
  kind: 'pay' | 'swap';
  prompt: string;
  expectTools: string[];
  recipient?: string;
  expectSats?: number;
  expectFrom?: string;
  expectTo?: string;
}
const NAMES = ['bob', 'alice', 'carol'];
export function multiCases(): MultiCase[] {
  const out: MultiCase[] = [];
  // Fiat send: resolve → fiat_to_sats → send_payment
  const fiat: [number, string][] = [[3, 'eur'], [10, 'usd'], [25, 'eur']];
  fiat.forEach(([amt, cur], i) => {
    const name = NAMES[i % NAMES.length]!;
    out.push({
      id: `fiat-${i}`, kind: 'pay',
      prompt: `pay ${name} ${amt} ${cur}`,
      recipient: name,
      expectTools: ['resolve_contact', 'fiat_to_sats', 'send_payment'],
      expectSats: Math.round((amt / RATE_USD) * 1e8),
    });
  });
  // Sats send: resolve → send_payment (no conversion)
  const sats = [5000, 21000, 100000];
  sats.forEach((s, i) => {
    const name = NAMES[(i + 1) % NAMES.length]!;
    out.push({
      id: `sats-${i}`, kind: 'pay',
      prompt: `send ${s} sats to ${name}`,
      recipient: name,
      expectTools: ['resolve_contact', 'send_payment'],
      expectSats: s,
    });
  });
  // Swap: get_swap_quote → execute_swap
  const swaps: [string, string, number][] = [['usdt', 'btc', 10], ['usdt', 'btc', 25], ['btc', 'usdt', 0.005]];
  swaps.forEach(([from, to, amt], i) => {
    out.push({
      id: `swap-${i}`, kind: 'swap',
      prompt: `swap ${amt} ${from} for ${to}`,
      expectTools: ['get_swap_quote', 'execute_swap'],
      expectFrom: from.toUpperCase(),
      expectTo: to.toUpperCase(),
    });
  });
  return out;
}

// ── Run one case in one mode ─────────────────────────────────────────────────
export type Mode = 'recipe' | 'free';
export interface MultiResult {
  model: string;
  mode: Mode;
  repeat: number;
  case: MultiCase;
  calls: string[];
  finalArgs: Record<string, unknown> | null;
  inferences: number;
  latencyMs: number;
  gateFired: boolean;
  coverage: boolean;
  order: boolean;
  finalOk: boolean;
  pass: boolean;
}

function grade(c: MultiCase, calls: string[], finalArgs: Record<string, unknown> | null, gateFired: boolean): Pick<MultiResult, 'coverage' | 'order' | 'finalOk' | 'pass'> {
  const coverage = c.expectTools.every((t) => calls.includes(t));
  if (c.kind === 'swap') {
    const qi = calls.indexOf('get_swap_quote');
    const ei = calls.indexOf('execute_swap');
    const order = qi >= 0 && ei >= 0 ? qi < ei : ei >= 0;
    let finalOk = false;
    if (finalArgs) {
      const from = String(finalArgs.from_asset ?? '').toUpperCase();
      const to = String(finalArgs.to_asset ?? '').toUpperCase();
      finalOk = (!c.expectFrom || from === c.expectFrom) && (!c.expectTo || to === c.expectTo);
    }
    return { coverage, order, finalOk, pass: coverage && order && finalOk && gateFired };
  }
  // pay
  const ri = calls.indexOf('resolve_contact');
  const si = calls.indexOf('send_payment');
  const order = ri >= 0 && si >= 0 ? ri < si : si >= 0;
  let finalOk = false;
  if (finalArgs) {
    const to = String(finalArgs.to ?? '').toLowerCase();
    const sats = Number(finalArgs.amount_sats ?? 0);
    const toOk = c.recipient ? to.includes(c.recipient) : true;
    const satsOk = (c.expectSats ?? 0) > 0 && Math.abs(sats - (c.expectSats ?? 0)) <= Math.max(1, (c.expectSats ?? 0) * 0.02);
    finalOk = toOk && satsOk;
  }
  return { coverage, order, finalOk, pass: coverage && order && finalOk && gateFired };
}

async function runCase(provider: LLMProvider, model: string, mode: Mode, c: MultiCase, repeat: number): Promise<MultiResult> {
  let inferences = 0;
  const counting: LLMProvider = { name: provider.name, runTurn: (i) => { inferences++; return provider.runTurn(i); } };
  const tools = stubRegistry();
  const calls: string[] = [];
  let finalArgs: Record<string, unknown> | null = null;
  let gateFired = false;
  const onConfirm = async (call: { name: string; arguments: Record<string, unknown> }) => {
    gateFired = true;
    finalArgs = call.arguments;
    return { approved: true };
  };

  const t0 = Date.now();
  try {
    const finalTools = ['send_payment', 'execute_swap'];
    if (mode === 'recipe') {
      const recipe: Recipe = c.kind === 'swap' ? swapRecipe : paymentsRecipe;
      const res = await runRecipe(recipe, c.prompt, {
        provider: counting,
        tools,
        onConfirm,
        onStep: (name, args) => { calls.push(name); if (finalTools.includes(name)) finalArgs = args; },
      });
      inferences = res.inferences;
    } else {
      const engine = new Engine({ provider: counting, tools, defaultMaxTurns: 6 });
      await engine.runAgentic([{ role: 'system', content: FREE_SYSTEM }, { role: 'user', content: c.prompt }], {
        onConfirm,
        onToolCall: (call) => { calls.push(call.name); if (finalTools.includes(call.name)) finalArgs = call.arguments; },
      });
    }
  } catch { /* record what we have */ }
  const latencyMs = Date.now() - t0;
  const g = grade(c, calls, finalArgs, gateFired);
  return { model, mode, repeat, case: c, calls, finalArgs, inferences, latencyMs, gateFired, ...g };
}

// ── Suite ────────────────────────────────────────────────────────────────────
export interface MultiOpts {
  mock?: boolean;
  models?: string[];
  repeats?: number;
  modes?: Mode[];
  onProgress?: (p: { done: number; total: number; model: string; mode: Mode }) => void;
}
export interface MultiCell { model: string; mode: Mode; cases: number; trials: number; pass: number; pct: number; reliablePct: number; avgInferences: number; avgLatency: number; coverage: number; order: number; finalOk: number; gate: number }

export interface MultiSuiteResult { cells: MultiCell[]; results: MultiResult[]; cases: number; repeats: number }

export async function runMultiStepSuite(opts: MultiOpts): Promise<MultiSuiteResult> {
  const repeats = Math.max(1, opts.repeats ?? 3);
  const modes = opts.modes ?? (['recipe', 'free'] as Mode[]);
  const cases = multiCases();
  const sdk = opts.mock ? null : await import('@qvac/sdk');
  const modelIds = opts.models ?? ['qwen3-0.6b'];
  const results: MultiResult[] = [];
  const total = modelIds.length * modes.length * cases.length * repeats;
  let done = 0;

  for (const modelId of modelIds) {
    let provider: LLMProvider;
    let label = modelId;
    let loaded: { id: string } | null = null;
    if (opts.mock) {
      provider = mockEvalProvider();
      label = 'mock';
    } else {
      const lp = await loadProvider(modelId, sdk);
      if (!lp) continue;
      provider = lp.provider;
      loaded = { id: lp.modelId };
    }
    for (const mode of modes) {
      for (const c of cases) {
        for (let r = 0; r < repeats; r++) {
          results.push(await runCase(provider, label, mode, c, r));
          done++;
          opts.onProgress?.({ done, total, model: label, mode });
        }
      }
    }
    if (loaded && sdk) await sdk.unloadModel?.({ modelId: loaded.id }).catch(() => {});
  }

  // Aggregate.
  const cells: MultiCell[] = [];
  const models = [...new Set(results.map((r) => r.model))];
  for (const model of models) {
    for (const mode of modes) {
      const rs = results.filter((r) => r.model === model && r.mode === mode);
      if (!rs.length) continue;
      const byCase = new Map<string, boolean[]>();
      for (const r of rs) { const a = byCase.get(r.case.id) ?? []; a.push(r.pass); byCase.set(r.case.id, a); }
      const reliable = [...byCase.values()].filter((a) => a.every(Boolean)).length;
      const avg = (f: (r: MultiResult) => number) => Math.round(rs.reduce((s, r) => s + f(r), 0) / rs.length);
      const pct = (f: (r: MultiResult) => boolean) => Math.round((rs.filter(f).length / rs.length) * 100);
      cells.push({
        model, mode, cases: byCase.size, trials: rs.length,
        pass: rs.filter((r) => r.pass).length,
        pct: pct((r) => r.pass),
        reliablePct: Math.round((reliable / byCase.size) * 100),
        avgInferences: Math.round((rs.reduce((s, r) => s + r.inferences, 0) / rs.length) * 10) / 10,
        avgLatency: avg((r) => r.latencyMs),
        coverage: pct((r) => r.coverage), order: pct((r) => r.order), finalOk: pct((r) => r.finalOk), gate: pct((r) => r.gateFired),
      });
    }
  }
  return { cells, results, cases: cases.length, repeats };
}
