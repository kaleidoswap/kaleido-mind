import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATASET_SCHEMA, DatasetCollector, exportTrainingPairs, summarizeDataset, datasetSplit, type DatasetRecord } from './dataset.js';
import { LocalDatasetStore } from './dataset-node.js';
const record = (patch: Partial<DatasetRecord> = {}): DatasetRecord => ({
  schema: DATASET_SCHEMA, id: 'turn-1', groupId: 'session-1', createdAt: '2026-10-09T10:00:00Z',
  source: 'synthetic', modality: 'voice',
  provenance: { model: 'mock', modelVersion: '1', appVersion: '1', promptVersion: '1' },
  consent: { collection: true, training: true, policyVersion: '1' },
  metrics: { totalMs: 120 }, checks: [{ name: 'confirmation', pass: true, critical: true }],
  content: { input: 'Hello', target: 'Hi' },
  review: { status: 'accepted', reviewer: 'curator-1', rubricVersion: '1' }, ...patch,
});
describe('dataset collection and export', () => {
  it('requires opt-in and drops content unless a sanitizer is supplied', async () => {
    const lines: string[] = [];
    const appendLine = async (line: string) => { lines.push(line); };
    expect(await new DatasetCollector({ appendLine }).record(record())).toBe(false);
    const collector = new DatasetCollector({ enabled: true, appendLine });
    expect(await collector.record(record({ consent: { collection: false, training: true, policyVersion: '1' } }))).toBe(false);
    await collector.record(record());
    expect(JSON.parse(lines[0]!).content).toBeUndefined();
    expect(lines).toHaveLength(1);
  });
  it('fails closed on sanitizer/storage errors', async () => {
    const collector = new DatasetCollector({ enabled: true, appendLine: async () => {}, sanitizeContent: () => { throw new Error('scrub failed'); } });
    await expect(collector.record(record())).rejects.toThrow('scrub failed');
  });
  it('requires training consent, accepted review and passing checks', () => {
    const patches: Partial<DatasetRecord>[] = [
      { review: undefined }, { content: undefined }, { checks: [] },
      { consent: { collection: true, training: false, policyVersion: '1' } },
      { checks: [{ name: 'safety', pass: false, critical: true }] },
      { source: 'evaluation' },
    ];
    for (const patch of patches) expect(exportTrainingPairs([record(patch)]).included).toBe(0);
    const exported = exportTrainingPairs([record()]);
    expect(exported.included).toBe(1);
    expect(JSON.parse((exported.train || exported.validation).trim()).messages).toHaveLength(2);
  });
  it('holds out entire evaluation groups and rejects duplicates', () => {
    expect(exportTrainingPairs([record(), record({ id: 'eval', source: 'evaluation' })]).included).toBe(0);
    expect(() => exportTrainingPairs([record(), record()])).toThrow('Duplicate');
    expect(datasetSplit('group')).toBe(datasetSplit('group'));
  });
  it('reports separate checks and latency percentiles without hiding failures', () => {
    const summary = summarizeDataset([record(), record({ id: '2', metrics: { totalMs: 900 }, checks: [{ name: 'confirmation', critical: true, pass: false }] })]);
    expect(summary.checks.confirmation).toEqual({ passed: 1, total: 2 });
    expect(summary.metrics.totalMs).toEqual({ count: 2, mean: 510, p50: 120, p95: 900 });
    expect(() => summarizeDataset([record({ metrics: { latency: NaN } })])).toThrow();
  });
  it('persists private records, expires reads, and supports group deletion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mind-dataset-'));
    let now = Date.parse('2026-10-09T10:00:00Z');
    const store = new LocalDatasetStore(dir, 1, () => now);
    try {
      await store.appendLine(JSON.stringify(record()));
      expect(await store.read()).toHaveLength(1);
      if (process.platform !== 'win32') expect((await stat(join(dir, (await readdir(dir))[0]!))).mode & 0o777).toBe(0o600);
      expect(await store.deleteGroup('session-1')).toBe(1);
      await store.appendLine(JSON.stringify(record()));
      now += 2 * 86_400_000;
      expect(await store.read()).toEqual([]);
      expect(await store.purgeExpired()).toBe(1);
      expect(await readdir(dir)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
