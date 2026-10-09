/** Portable, opt-in collection. Hosts own consent UI, storage and deletion. */
export const DATASET_SCHEMA = 'kaleidomind.dataset.v1' as const;
export interface DatasetRecord {
  schema: typeof DATASET_SCHEMA;
  id: string;
  /** Pseudonymous group ID; keep related sessions/scenario variants together. */
  groupId: string;
  createdAt: string;
  source: 'production' | 'synthetic' | 'evaluation';
  modality: 'text' | 'voice';
  provenance: { model: string; modelVersion: string; appVersion: string; promptVersion: string };
  consent: { collection: boolean; training: boolean; policyVersion: string };
  metrics: Record<string, number>;
  checks: { name: string; pass: boolean; critical: boolean }[];
  /** Separately curated text pairs, not reasoning traces or raw tool logs. */
  content?: { input: string; target: string };
  review?: { status: 'accepted' | 'rejected'; reviewer: string; rubricVersion: string };
}
export type DatasetInput = Omit<DatasetRecord, 'schema'>;
export interface DatasetCollectorOptions {
  /** Off unless explicitly enabled by the host. */
  enabled?: boolean;
  appendLine: (line: string) => Promise<void>;
  /** Required to collect text. Must scrub application-specific PII as well. */
  sanitizeContent?: (content: NonNullable<DatasetRecord['content']>) => NonNullable<DatasetRecord['content']>;
}

export function validateDatasetRecord(value: unknown): asserts value is DatasetRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid dataset record');
  const r = value as DatasetRecord;
  const nonempty = (s: unknown) => typeof s === 'string' && s.trim().length > 0;
  if (r.schema !== DATASET_SCHEMA || !nonempty(r.id) || !nonempty(r.groupId)
    || !nonempty(r.createdAt) || !Number.isFinite(Date.parse(r.createdAt))
    || !['production', 'synthetic', 'evaluation'].includes(r.source)
    || !['text', 'voice'].includes(r.modality)
    || !r.provenance || !['model', 'modelVersion', 'appVersion', 'promptVersion'].every(k => nonempty(r.provenance[k as keyof typeof r.provenance]))
    || !r.consent || typeof r.consent.collection !== 'boolean' || typeof r.consent.training !== 'boolean' || !nonempty(r.consent.policyVersion)
    || !r.metrics || typeof r.metrics !== 'object' || Array.isArray(r.metrics)
    || !Object.values(r.metrics).every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    || !Array.isArray(r.checks) || !r.checks.every(c => c && nonempty(c.name) && typeof c.pass === 'boolean' && typeof c.critical === 'boolean')
    || (r.content !== undefined && (!r.content || !nonempty(r.content.input) || !nonempty(r.content.target)))
    || (r.review !== undefined && (!r.review || !['accepted', 'rejected'].includes(r.review.status) || !nonempty(r.review.reviewer) || !nonempty(r.review.rubricVersion)))) {
    throw new Error('Invalid dataset record');
  }
}

export class DatasetCollector {
  constructor(private readonly options: DatasetCollectorOptions) {}
  async record(input: DatasetInput): Promise<boolean> {
    if (!this.options.enabled || !input.consent.collection) return false;
    // Explicit allowlist: no arbitrary metadata, audio, secrets or raw reasoning.
    const record: DatasetRecord = {
      schema: DATASET_SCHEMA, id: input.id, groupId: input.groupId,
      createdAt: input.createdAt, source: input.source, modality: input.modality,
      provenance: { model: input.provenance.model, modelVersion: input.provenance.modelVersion,
        appVersion: input.provenance.appVersion, promptVersion: input.provenance.promptVersion },
      consent: { collection: input.consent.collection, training: input.consent.training, policyVersion: input.consent.policyVersion },
      metrics: { ...input.metrics },
      checks: input.checks.map(c => ({ name: c.name, pass: c.pass, critical: c.critical })),
    };
    if (input.review) record.review = { status: input.review.status, reviewer: input.review.reviewer, rubricVersion: input.review.rubricVersion };
    if (input.content && this.options.sanitizeContent) {
      const text = this.options.sanitizeContent(input.content);
      record.content = { input: text.input, target: text.target };
    }
    validateDatasetRecord(record);
    await this.options.appendLine(JSON.stringify(record));
    return true;
  }
}

/** Stable group split: related records never land in both train and validation. */
export function datasetSplit(groupId: string): 'train' | 'validation' {
  let hash = 2166136261;
  for (let i = 0; i < groupId.length; i++) hash = Math.imul(hash ^ groupId.charCodeAt(i), 16777619);
  return (hash >>> 0) % 100 < 20 ? 'validation' : 'train';
}

/** Conservative text-SFT export. Evaluation-only records are always held out. */
export function exportTrainingPairs(records: DatasetRecord[]): {
  train: string; validation: string; included: number; excluded: number;
} {
  const rows = { train: [] as string[], validation: [] as string[] };
  const ids = new Set<string>();
  // A group used for evaluation must never leak through another source label.
  const heldout = new Set(records.filter(r => r.source === 'evaluation').map(r => r.groupId));
  let excluded = 0;
  for (const record of records) {
    validateDatasetRecord(record);
    if (ids.has(record.id)) throw new Error(`Duplicate dataset record: ${record.id}`);
    ids.add(record.id);
    if (!record.consent.collection || !record.consent.training || heldout.has(record.groupId)
      || record.review?.status !== 'accepted' || !record.content
      || !record.checks.some(c => c.critical) || record.checks.some(c => !c.pass)) {
      excluded++;
      continue;
    }
    rows[datasetSplit(record.groupId)].push(JSON.stringify({ messages: [
      { role: 'user', content: record.content.input },
      { role: 'assistant', content: record.content.target },
    ] }));
  }
  const jsonl = (lines: string[]) => lines.length ? `${lines.join('\n')}\n` : '';
  return { train: jsonl(rows.train), validation: jsonl(rows.validation),
    included: rows.train.length + rows.validation.length, excluded };
}

/** Report dimensions separately: a high completion rate cannot hide failed safety checks. */
export function summarizeDataset(records: DatasetRecord[]) {
  const checks: Record<string, { passed: number; total: number }> = Object.create(null);
  const metrics: Record<string, { count: number; mean: number; p50: number; p95: number }> = Object.create(null);
  const values: Record<string, number[]> = Object.create(null);
  for (const record of records) {
    validateDatasetRecord(record);
    for (const check of record.checks) {
      const c = checks[check.name] ??= { passed: 0, total: 0 };
      c.total++; if (check.pass) c.passed++;
    }
    for (const [name, value] of Object.entries(record.metrics)) (values[name] ??= []).push(value);
  }
  for (const [name, samples] of Object.entries(values)) {
    samples.sort((a, b) => a - b);
    metrics[name] = { count: samples.length, mean: samples.reduce((a, b) => a + b, 0) / samples.length,
      p50: samples[Math.ceil(samples.length * .5) - 1]!, p95: samples[Math.ceil(samples.length * .95) - 1]! };
  }
  return { records: records.length, checks, metrics };
}
