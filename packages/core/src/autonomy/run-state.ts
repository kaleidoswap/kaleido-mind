/**
 * TaskRunLog — what each task did, when, and what it cost. Port of kaleidoagent's
 * agent-state.ts (LoopStats + recent-runs + cumulative cost), generalized and
 * decoupled from the HTTP status server. This is the "memory of the tasks": the
 * record the UI reads to show "rebalance last ran 2h ago, cost $0.003".
 *
 * In-memory with optional injected persistence. Pure TS, zero deps.
 */

import type {
  RunLogIO,
  RunLogSnapshot,
  TaskRunCost,
  TaskRunRecord,
  TaskStats,
} from './types.js';

const ZERO_COST: TaskRunCost = { usd: 0, inputTokens: 0, outputTokens: 0 };
const DEFAULT_MAX_RECENT = 20;
const TEXT_CAP = 800;

export interface RunLogOptions {
  /** Persistence (load on first use, save on writes). Omit for ephemeral logs. */
  io?: RunLogIO;
  /** How many recent runs to retain. Default 20. */
  maxRecent?: number;
  /** Clock — injectable for deterministic tests. */
  now?: () => number;
}

export class TaskRunLog {
  private stats: Record<string, TaskStats> = {};
  private recentRuns: TaskRunRecord[] = [];
  private cumulative: TaskRunCost = { ...ZERO_COST };
  private hydrated = false;
  private readonly io?: RunLogIO;
  private readonly maxRecent: number;
  private readonly now: () => number;

  constructor(opts: RunLogOptions = {}) {
    this.io = opts.io;
    this.maxRecent = opts.maxRecent ?? DEFAULT_MAX_RECENT;
    this.now = opts.now ?? (() => Date.now());
  }

  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    if (this.io) {
      try {
        const snap = await this.io.load();
        if (snap) {
          this.stats = snap.stats ?? {};
          this.recentRuns = snap.recent ?? [];
          this.cumulative = snap.cumulative ?? { ...ZERO_COST };
        }
      } catch {
        /* start fresh on a corrupt/absent snapshot */
      }
    }
  }

  private async persist(): Promise<void> {
    if (this.io) await this.io.save(this.snapshotSync());
  }

  private ensure(taskId: string): TaskStats {
    const existing = this.stats[taskId];
    if (existing) return existing;
    const fresh: TaskStats = {
      runs: 0,
      errors: 0,
      lastRunAt: null,
      lastDurationMs: null,
      lastToolCalls: null,
      lastError: null,
      lastText: null,
    };
    this.stats[taskId] = fresh;
    return fresh;
  }

  /** Record a completed run (success or failure). */
  async record(record: TaskRunRecord): Promise<void> {
    await this.hydrate();
    const s = this.ensure(record.taskId);
    s.runs += 1;
    s.lastRunAt = record.startedAt;
    s.lastDurationMs = record.durationMs;
    s.lastToolCalls = record.toolCalls;
    if (record.ok) {
      s.lastError = null;
      s.lastText = record.text.slice(0, TEXT_CAP);
    } else {
      s.errors += 1;
      s.lastError = record.error;
    }

    this.cumulative = {
      usd: this.cumulative.usd + record.cost.usd,
      inputTokens: this.cumulative.inputTokens + record.cost.inputTokens,
      outputTokens: this.cumulative.outputTokens + record.cost.outputTokens,
    };

    this.recentRuns.unshift({ ...record, text: record.text.slice(0, TEXT_CAP) });
    if (this.recentRuns.length > this.maxRecent) {
      this.recentRuns.length = this.maxRecent;
    }
    await this.persist();
  }

  async statsFor(taskId: string): Promise<TaskStats | null> {
    await this.hydrate();
    return this.stats[taskId] ?? null;
  }

  async allStats(): Promise<Record<string, TaskStats>> {
    await this.hydrate();
    return { ...this.stats };
  }

  async recent(limit?: number): Promise<TaskRunRecord[]> {
    await this.hydrate();
    return this.recentRuns.slice(0, limit ?? this.recentRuns.length);
  }

  async totalCost(): Promise<TaskRunCost> {
    await this.hydrate();
    return { ...this.cumulative };
  }

  async snapshot(): Promise<RunLogSnapshot> {
    await this.hydrate();
    return this.snapshotSync();
  }

  private snapshotSync(): RunLogSnapshot {
    return {
      stats: { ...this.stats },
      recent: [...this.recentRuns],
      cumulative: { ...this.cumulative },
    };
  }
}
