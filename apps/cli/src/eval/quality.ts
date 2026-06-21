/**
 * Eval Track D — response quality. Track A measures tool *selection* (solved at
 * 0.6B); this measures whether the model actually *knows and explains* things
 * correctly — the dimension where a bigger model (1.7B+) earns its keep and
 * where decision-only tracks are blind.
 *
 * Open-ended Bitcoin/Lightning/RGB questions, graded deterministically (so it's
 * reproducible — no LLM-judge bias):
 *   - coverage:  fraction of required facts present (each fact = an OR-group of
 *                acceptable terms, so synonyms count).
 *   - hallucination: a known-wrong "trap" phrase appears → fail.
 *   - conciseness: answer stays within a word bound (small models ramble).
 */

import type { InferenceMetrics, LLMProvider } from '@kaleidorg/mind';
import { loadProvider, mockEvalProvider } from './run.js';

const SYSTEM =
  'You are a concise Bitcoin, Lightning and RGB expert. Answer the question ' +
  'accurately in 1–3 short sentences. Do not invent facts; if unsure, say so.';

export interface QualityCase {
  id: string;
  category: 'knowledge' | 'reasoning';
  prompt: string;
  /** Each inner array is an OR-group: any one term satisfies that fact. */
  facts: string[][];
  /** Known-wrong phrases that must NOT appear (hallucination traps). */
  traps?: string[];
  maxWords?: number;
}

export function qualityCases(): QualityCase[] {
  return [
    { id: 'sat', category: 'knowledge', prompt: 'What is a satoshi?', facts: [['smallest', 'sub-unit', 'subunit'], ['100 million', '0.00000001', '1e-8', 'hundred million', '100,000,000']], maxWords: 60 },
    { id: 'channel', category: 'knowledge', prompt: 'How does a Lightning channel work?', facts: [['off-chain', 'offchain', 'off chain'], ['two', 'both', 'counterpart', 'peer'], ['on-chain', 'onchain', 'open', 'close', 'settle']], maxWords: 90 },
    { id: 'rgb', category: 'knowledge', prompt: 'What is RGB on Bitcoin?', facts: [['bitcoin'], ['asset', 'token', 'stablecoin'], ['client-side', 'off-chain', 'smart contract', 'lightning']], maxWords: 90 },
    { id: 'btc', category: 'knowledge', prompt: 'What is Bitcoin in one sentence?', facts: [['decentralized', 'peer-to-peer', 'p2p', 'no central'], ['digital', 'currency', 'money', 'cash']], maxWords: 60 },
    { id: 'onchain-ln', category: 'reasoning', prompt: 'What is the difference between an on-chain payment and a Lightning payment?', facts: [['lightning'], ['fast', 'instant', 'cheap', 'low fee', 'off-chain'], ['on-chain', 'base layer', 'slower', 'block', 'fee']], maxWords: 90 },
    { id: 'seed', category: 'knowledge', prompt: 'What is a seed phrase?', facts: [['recover', 'backup', 'restore', 'recovery'], ['word', 'mnemonic', '12', '24']], traps: ['share it publicly', 'give it to support'], maxWords: 70 },
    { id: 'small-pay', category: 'reasoning', prompt: 'I want to send a very small amount of bitcoin cheaply and instantly. What should I use?', facts: [['lightning'], ['fee', 'cheap', 'low', 'instant', 'fast']], maxWords: 60 },
    { id: 'confirm', category: 'knowledge', prompt: 'What does it mean when a Bitcoin transaction has confirmations?', facts: [['block'], ['included', 'mined', 'confirmed', 'irreversible', 'deeper', 'secure']], maxWords: 70 },
    { id: 'privkey', category: 'knowledge', prompt: 'What is a private key used for in a Bitcoin wallet?', facts: [['sign', 'spend', 'control', 'access', 'authorize'], ['secret', 'private', 'never share', 'keep']], traps: ['share with anyone'], maxWords: 60 },
    { id: 'usdt-ln', category: 'reasoning', prompt: 'Can I hold USDT on the Lightning Network, and how?', facts: [['rgb', 'asset', 'taproot'], ['lightning', 'channel', 'off-chain']], maxWords: 80 },
  ];
}

export interface QualityResult {
  model: string; repeat: number; case: QualityCase;
  response: string; words: number; latencyMs: number;
  inference?: InferenceMetrics;
  coverage: number; hallucinated: boolean; concise: boolean; pass: boolean;
}

function grade(c: QualityCase, response: string): Pick<QualityResult, 'coverage' | 'hallucinated' | 'concise' | 'pass' | 'words'> {
  const lower = response.toLowerCase();
  const covered = c.facts.filter((group) => group.some((t) => lower.includes(t.toLowerCase()))).length;
  const coverage = c.facts.length ? covered / c.facts.length : 1;
  const hallucinated = (c.traps ?? []).some((t) => lower.includes(t.toLowerCase()));
  const words = response.trim() ? response.trim().split(/\s+/).length : 0;
  const concise = !c.maxWords || words <= c.maxWords * 1.5; // soft bound
  const answered = words >= 5;
  const pass = answered && coverage >= 0.5 && !hallucinated;
  return { coverage, hallucinated, concise, pass, words };
}

async function runCase(provider: LLMProvider, model: string, c: QualityCase, repeat: number): Promise<QualityResult> {
  const t0 = Date.now();
  let response = '';
  let inference: InferenceMetrics | undefined;
  try {
    const out = await provider.runTurn({ system: SYSTEM, messages: [{ role: 'user', content: c.prompt }], tools: [] });
    response = (out.text ?? '').trim();
    inference = out.inference;
  } catch { /* empty */ }
  const latencyMs = Date.now() - t0;
  return { model, repeat, case: c, response, latencyMs, inference, ...grade(c, response) };
}

export interface QualityCell {
  model: string; trials: number; pass: number; passPct: number;
  coveragePct: number; hallucPct: number; avgWords: number; avgLatency: number;
}
export interface QualitySuiteResult { cells: QualityCell[]; results: QualityResult[]; cases: number; repeats: number }

export interface QualityOpts { mock?: boolean; models?: string[]; repeats?: number; onProgress?: (p: { done: number; total: number; model: string }) => void }

export async function runQualitySuite(opts: QualityOpts): Promise<QualitySuiteResult> {
  const repeats = Math.max(1, opts.repeats ?? 3);
  const cases = qualityCases();
  const sdk = opts.mock ? null : await import('@qvac/sdk');
  const modelIds = opts.models ?? ['qwen3-0.6b'];
  const results: QualityResult[] = [];
  const total = modelIds.length * cases.length * repeats;
  let done = 0;

  for (const modelId of modelIds) {
    let provider: LLMProvider; let label = modelId; let loaded: { id: string } | null = null;
    if (opts.mock) { provider = mockEvalProvider(); label = 'mock'; }
    else { const lp = await loadProvider(modelId, sdk); if (!lp) continue; provider = lp.provider; loaded = { id: lp.modelId }; }
    for (const c of cases) {
      for (let r = 0; r < repeats; r++) {
        results.push(await runCase(provider, label, c, r));
        done++; opts.onProgress?.({ done, total, model: label });
      }
    }
    if (loaded && sdk) await sdk.unloadModel?.({ modelId: loaded.id }).catch(() => {});
  }

  const cells: QualityCell[] = [];
  for (const model of [...new Set(results.map((r) => r.model))]) {
    const rs = results.filter((r) => r.model === model);
    const avg = (f: (r: QualityResult) => number) => Math.round(rs.reduce((s, r) => s + f(r), 0) / rs.length);
    cells.push({
      model, trials: rs.length, pass: rs.filter((r) => r.pass).length,
      passPct: Math.round((rs.filter((r) => r.pass).length / rs.length) * 100),
      coveragePct: Math.round((rs.reduce((s, r) => s + r.coverage, 0) / rs.length) * 100),
      hallucPct: Math.round((rs.filter((r) => r.hallucinated).length / rs.length) * 100),
      avgWords: avg((r) => r.words), avgLatency: avg((r) => r.latencyMs),
    });
  }
  return { cells, results, cases: cases.length, repeats };
}
