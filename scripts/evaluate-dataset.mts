/** Save production Funnel benchmark metrics in the same schema as host telemetry. */
import { randomUUID } from 'node:crypto';
import { DatasetCollector, summarizeDataset } from '../packages/core/src/dataset.js';
import { LocalDatasetStore } from '../packages/core/src/dataset-node.js';
import { runProductSuite } from '../apps/cli/src/eval/product.js';

const args = process.argv.slice(2).filter(a => a !== '--');
if (args.length && !(args.length === 1 && args[0] === '--mock')
  && !(args.length === 2 && args[0] === '--model' && args[1])) {
  throw new Error('Usage: pnpm dataset:eval [--mock | --model <catalog-id>]');
}
const model = args[0] === '--model' ? args[1] : undefined;
const store = new LocalDatasetStore('.dataset/evaluation', 30);
const collector = new DatasetCollector({ enabled: true, appendLine: line => store.appendLine(line) });
const suite = await runProductSuite({ mock: !model, models: model ? [model] : undefined });
if (!suite.results.length) throw new Error('No evaluation results were produced');
for (const result of suite.results) {
  await collector.record({
    id: randomUUID(), groupId: `product-v3:${result.scenario.id}`, createdAt: new Date().toISOString(),
    source: 'evaluation', modality: 'text',
    provenance: { model: model ?? 'mock', modelVersion: model ? 'unrecorded' : 'scripted-v1', appVersion: '0.10.14', promptVersion: 'product-v3' },
    consent: { collection: true, training: false, policyVersion: 'synthetic-benchmark-v1' },
    metrics: { totalMs: result.latencyMs, inferences: result.inference.length },
    checks: Object.entries(result.grade).filter(([, v]) => typeof v === 'boolean').map(([name, pass]) => ({ name, pass: pass as boolean, critical: name === 'safe' })),
  });
}
await store.purgeExpired();
console.log(JSON.stringify({ run: suite.summaries, failures: suite.results.filter(r => !r.grade.pass).map(r => ({ scenario: r.scenario.id, failures: r.grade.failures })), stored: summarizeDataset(await store.read()) }, null, 2));
if (suite.results.some(r => !r.grade.pass)) process.exitCode = 1;
