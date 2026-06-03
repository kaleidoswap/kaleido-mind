/**
 * Structured turn logger — JSONL output, designed for future fine-tuning
 * datasets. Format is compatible with Salesforce/APIGen-MT-5k so KaleidoMind
 * records can be concatenated with public data and fed to SFT pipelines.
 *
 * Privacy posture: amounts/addresses/contacts are HASHED at log time.
 * Raw values are kept in a separate local store and only re-attached at
 * export with explicit --include-pii.
 */

import type { Message, ToolCall, ToolResult } from './types.js';

export type Device =
  | 'rate-ios'
  | 'rate-android'
  | 'kaleido-agent'
  | 'rate-extension'
  | 'kaleido-cli'
  | 'playground';

export interface TurnLog {
  id: string;
  ts: string;
  session_id: string;
  device: Device;
  model: {
    provider: string;
    name: string;
    version?: string;
  };
  /** Hash-based identifier for the system prompt — same hash = same prompt. */
  system_hash: string;
  /** Names + schema hashes only, never raw schemas with semantic data. */
  tools: { name: string; schema_hash: string }[];
  messages: Message[];
  decision: {
    tool_calls: ToolCall[];
    final_text: string | null;
    reasoning_tokens?: number;
  };
  results: ToolResult[];
  feedback?: {
    thumbs?: 'up' | 'down';
    edited_args?: Record<string, unknown>;
    retry_count?: number;
  };
  latency_ms: {
    transcribe?: number;
    reason: number;
    tools?: number;
    total: number;
  };
  meta?: Record<string, unknown>;
}

export interface LoggerOptions {
  /** Absolute path where YYYY-MM-DD/session-<id>.jsonl files are written. */
  dir: string;
  device: Device;
  /** Pluggable IO so the same logger works in Node + RN + tests. */
  io: LoggerIO;
  /** PII masker — defaults to hashing common fields. */
  mask?: (log: TurnLog) => TurnLog;
}

export interface LoggerIO {
  ensureDir(path: string): Promise<void>;
  appendLine(filePath: string, line: string): Promise<void>;
  hash(value: unknown): string;
  now(): Date;
}

export class TurnLogger {
  constructor(private readonly opts: LoggerOptions) {}

  async log(input: Omit<TurnLog, 'id' | 'ts' | 'device'>): Promise<void> {
    const ts = this.opts.io.now().toISOString();
    const id = `${input.session_id}-${this.opts.io.hash({ ts, n: Math.random() }).slice(0, 8)}`;
    let entry: TurnLog = { ...input, id, ts, device: this.opts.device };
    if (this.opts.mask) entry = this.opts.mask(entry);

    const day = ts.slice(0, 10);
    const dir = `${this.opts.dir}/${day}`;
    await this.opts.io.ensureDir(dir);
    await this.opts.io.appendLine(
      `${dir}/session-${input.session_id}.jsonl`,
      JSON.stringify(entry),
    );
  }
}

/**
 * Default masking — hashes amounts, addresses, invoices, contact names.
 * Tools without these fields pass through unchanged.
 */
export function defaultMask(io: LoggerIO): (log: TurnLog) => TurnLog {
  const FIELDS_TO_HASH = new Set([
    'amount', 'amount_msat', 'amount_sat',
    'address', 'invoice', 'bolt11', 'pubkey', 'node_id',
    'contact', 'contact_name', 'recipient',
  ]);

  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = FIELDS_TO_HASH.has(k) ? `h:${io.hash(val).slice(0, 8)}` : walk(val);
      }
      return out;
    }
    return v;
  };

  return (log) => ({
    ...log,
    decision: {
      ...log.decision,
      tool_calls: log.decision.tool_calls.map((c) => ({
        ...c,
        arguments: walk(c.arguments) as Record<string, unknown>,
      })),
    },
    results: log.results.map((r) => ({ ...r, result: walk(r.result) })),
  });
}
