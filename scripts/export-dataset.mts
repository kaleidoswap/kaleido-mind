import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exportTrainingPairs, summarizeDataset } from '../packages/core/src/dataset.js';
import { LocalDatasetStore } from '../packages/core/src/dataset-node.js';

const args = process.argv.slice(2).filter(a => a !== '--');
if (args.length !== 1) throw new Error('Usage: pnpm dataset:export <local-store-directory>');
const records = await new LocalDatasetStore(args[0]!, 30).read();
const result = exportTrainingPairs(records);
const out = join('.dataset', 'exports', randomUUID());
await mkdir(out, { recursive: true, mode: 0o700 });
for (const [name, text] of Object.entries({
  'train.jsonl': result.train,
  'validation.jsonl': result.validation,
  'manifest.json': JSON.stringify({ schema: 'kaleidomind.export.v1', createdAt: new Date().toISOString(),
    included: result.included, excluded: result.excluded, split: 'fnv1a-group-v1-80/20',
    sourceRecords: records.map(r => ({ id: r.id, groupId: r.groupId, provenance: r.provenance })),
    summary: summarizeDataset(records) }, null, 2),
})) await writeFile(join(out, name), text, { mode: 0o600, flag: 'wx' });
console.log(`Exported ${result.included}; excluded ${result.excluded}. Files: ${out}`);
