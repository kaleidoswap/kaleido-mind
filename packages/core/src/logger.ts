/** JSONL diagnostic logs. Redaction is defense in depth, not anonymization.
 * Collection/retention consent belongs to the host. Use ./dataset for curated training data.
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
  /** Replaces the default policy: omit free text and hash common financial fields. */
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
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.session_id)) throw new Error('Invalid log session ID');
    const ts = this.opts.io.now().toISOString();
    const id = `${input.session_id}-${this.opts.io.hash({ ts, n: Math.random() }).slice(0, 8)}`;
    let entry: TurnLog = { ...input, id, ts, device: this.opts.device };
    entry = (this.opts.mask ?? defaultMask(this.opts.io))(entry);

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
 * Free-form text, messages and metadata are omitted/redacted by default.
 * Supply a custom masker only with an explicit content collection policy.
 */
export function defaultMask(io: LoggerIO): (log: TurnLog) => TurnLog {
  const FIELDS_TO_HASH = new Set([
    'amount', 'amount_msat', 'amount_sat', 'amount_sats',
    'address', 'invoice', 'bolt11', 'pubkey', 'node_id',
    'contact', 'contact_name', 'recipient',
  ]);

  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object') {
      const out: Record<string, unknown> = Object.create(null);
      for (const [k, val] of Object.entries(v)) {
        out[k] = /seed|mnemonic|private.?key|password|secret|token|authorization|preimage/i.test(k) ? '[redacted]' : FIELDS_TO_HASH.has(k) ? `h:${io.hash(val).slice(0, 8)}` : walk(val);
      }
      return out;
    }
    if (typeof v === 'string') return '[text-redacted]';
    return v;
  };

  return (log) => ({
    ...log,
    messages: [],
    feedback: log.feedback ? { thumbs: log.feedback.thumbs, retry_count: log.feedback.retry_count } : undefined,
    meta: undefined,
    decision: {
      ...log.decision,
      final_text: log.decision.final_text === null ? null : '[text-redacted]',
      tool_calls: log.decision.tool_calls.map((c) => ({
        ...c,
        arguments: walk(c.arguments) as Record<string, unknown>,
      })),
    },
    results: log.results.map((r) => ({ name: r.name, arguments: walk(r.arguments) as Record<string, unknown>, result: walk(r.result) })),
  });
}
