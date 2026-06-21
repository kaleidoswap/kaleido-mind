/**
 * Hackathon evidence JSONL.
 *
 * This is deliberately transport-neutral: Node writes it to disk, React Native
 * writes it to the app documents directory, and tests keep it in memory.
 */
import type { InferenceMetrics } from './providers/types.js';

export const EVIDENCE_SCHEMA = 'kaleidomind.evidence.v1' as const;

export type EvidenceSurface = 'desktop' | 'mobile' | 'cli' | 'test';
export type EvidenceEventType =
  | 'model_load'
  | 'model_unload'
  | 'inference'
  | 'tool_call'
  | 'tool_result'
  | 'confirmation'
  | 'error';

export interface EvidenceEvent {
  schema: typeof EVIDENCE_SCHEMA;
  event: EvidenceEventType;
  ts: string;
  runId: string;
  surface: EvidenceSurface;
  model?: {
    name: string;
    version?: string;
    source?: 'local' | 'delegated';
  };
  hardware?: {
    device: string;
    os?: string;
    memoryGb?: number;
  };
  prompt?: string;
  response?: string;
  inference?: InferenceMetrics | InferenceMetrics[];
  tool?: {
    name: string;
    arguments?: Record<string, unknown>;
    result?: unknown;
  };
  confirmation?: {
    tool: string;
    approved: boolean;
    reason?: string;
  };
  error?: {
    name: string;
    message: string;
  };
  meta?: Record<string, unknown>;
}

export type EvidenceInput = Omit<EvidenceEvent, 'schema' | 'ts'>;

export interface EvidenceIO {
  appendLine(line: string): Promise<void>;
  now(): Date;
}

export interface EvidenceRecorderOptions {
  io: EvidenceIO;
  sanitize?: (event: EvidenceEvent) => EvidenceEvent;
}

export class EvidenceRecorder {
  constructor(private readonly opts: EvidenceRecorderOptions) {}

  async record(input: EvidenceInput): Promise<EvidenceEvent> {
    let event: EvidenceEvent = {
      ...input,
      schema: EVIDENCE_SCHEMA,
      ts: this.opts.io.now().toISOString(),
    };
    event = (this.opts.sanitize ?? sanitizeEvidenceEvent)(event);
    await this.opts.io.appendLine(JSON.stringify(event));
    return event;
  }
}

const SENSITIVE_KEYS = new Set([
  'address',
  'invoice',
  'bolt11',
  'seed',
  'mnemonic',
  'private_key',
  'privateKey',
  'access_token',
  'accessToken',
  'preimage',
]);

const PAYMENT_TOKEN =
  /\b(?:ln(?:bc|tb|bcrt)[0-9a-z]{20,}|(?:bc1|tb1|bcrt1)[0-9a-z]{20,})\b/gi;

/** Mask wallet secrets while preserving prompts, model output and benchmark value. */
export function sanitizeEvidenceEvent(event: EvidenceEvent): EvidenceEvent {
  const walk = (value: unknown, key?: string): unknown => {
    if (key && SENSITIVE_KEYS.has(key)) return '[redacted]';
    if (typeof value === 'string') return value.replace(PAYMENT_TOKEN, '[payment-data-redacted]');
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v, k)]),
      );
    }
    return value;
  };
  return walk(event) as EvidenceEvent;
}
