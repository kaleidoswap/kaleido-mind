/** Reusable eval orchestration — shared by the CLI `eval` command and the web server. */

import * as os from 'node:os';
import { join } from 'node:path';
import { generateDataset } from './dataset.js';
import { MECHANISMS, runCase, loadProvider, mockEvalProvider, type Mechanism, type CaseResult } from './run.js';
import { aggregate, writeReport, type Aggregate } from './report.js';
import { getModel } from '../catalog.js';
import { listInstalled } from '../models.js';
import { MIND_DIR } from '../config.js';

/** Structured live progress — what the CLI prints and the web dashboard polls. */
export interface Progress {
  running: boolean;
  startedAt: number;
  done: number;
  total: number;
  model?: string;
  mechanism?: string;
  loadMs?: number;
  phase?: 'loading' | 'evaluating' | 'done' | 'error';
  message?: string;
}

export interface EvalOpts {
  mock?: boolean;
  models?: string[];          // catalog ids; default = installed LLMs
  mechanisms?: Mechanism[];
  per?: number;               // paraphrases per intent
  sample?: number;            // cap total cases
  seed?: number;
  onProgress?: (p: Progress) => void;
}

export interface EvalTiming {
  totalMs: number;
  perModelLoadMs: Record<string, number>;
}

export interface EvalRun {
  dir: string;
  agg: Aggregate;
  results: CaseResult[];
  ts: number;
  timing: EvalTiming;
}

const ramGb = (b: number) => (b / 1024 ** 3).toFixed(1);

/** Run the full model × mechanism × case matrix and write the report dir. */
export async function runEvalSuite(opts: EvalOpts): Promise<EvalRun> {
  const emit = opts.onProgress ?? (() => {});
  const mechs = (opts.mechanisms ?? MECHANISMS).filter((m) => MECHANISMS.includes(m));
  let cases = generateDataset(opts.seed ?? 42, opts.per ?? 4);
  if (opts.sample) cases = cases.slice(0, opts.sample);

  let modelIds: string[];
  if (opts.mock) modelIds = ['mock'];
  else {
    const installed = (await listInstalled()).filter((m) => getModel(m.id)?.kind === 'llm' || getModel(m.id)?.kind === 'psy').map((m) => m.id);
    modelIds = opts.models?.length ? opts.models : installed;
  }
  if (!modelIds.length) throw new Error('No models to evaluate (none installed; pull one or use mock).');

  const sdk = opts.mock ? null : await import('@qvac/sdk');
  const results: CaseResult[] = [];
  const startedAt = Date.now();
  const total = modelIds.length * mechs.length * cases.length;
  const perModelLoadMs: Record<string, number> = {};
  let done = 0;
  const tick = (p: Partial<Progress>) => emit({ running: true, startedAt, done, total, ...p });

  for (const modelId of modelIds) {
    let provider; let label = modelId; let loadedId: string | null = null;
    if (opts.mock) { provider = mockEvalProvider(); label = 'mock'; perModelLoadMs[label] = 0; }
    else {
      tick({ model: getModel(modelId)?.displayName ?? modelId, phase: 'loading', message: 'loading model…' });
      const t0 = Date.now();
      const lp = await loadProvider(modelId, sdk);
      if (!lp) { tick({ phase: 'evaluating', message: `skip ${modelId} (not installed)` }); done += mechs.length * cases.length; continue; }
      provider = lp.provider; loadedId = lp.modelId; label = getModel(modelId)?.displayName ?? modelId;
      const loadMs = Date.now() - t0;
      perModelLoadMs[label] = loadMs;
      tick({ model: label, phase: 'loading', loadMs, message: `loaded in ${(loadMs / 1000).toFixed(1)}s` });
    }
    for (const mech of mechs) {
      for (const cse of cases) {
        results.push(await runCase(provider, label, mech, cse));
        done++;
        tick({ model: label, mechanism: mech, phase: 'evaluating' });
      }
    }
    if (sdk && loadedId) await sdk.unloadModel({ modelId: loadedId }).catch(() => {});
  }

  const agg = aggregate(results);
  const ts = Date.now();
  const timing: EvalTiming = { totalMs: ts - startedAt, perModelLoadMs };
  const dir = await writeReport(join(MIND_DIR, 'logs'), results, agg, {
    ts, dataset: cases.length, mode: opts.mock ? 'mock' : 'qvac',
    hardware: `${os.platform()}/${os.arch()} ${ramGb(os.totalmem())}GB`, timing,
  });
  if (sdk?.close) await sdk.close();
  emit({ running: false, startedAt, done, total, phase: 'done', message: `done in ${(timing.totalMs / 1000).toFixed(1)}s` });
  return { dir, agg, results, ts, timing };
}
