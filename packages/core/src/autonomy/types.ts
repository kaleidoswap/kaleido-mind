/**
 * Autonomy — the agent's task brain.
 *
 * This is the half of "the agent's memory" the {@link ../memory/types MemoryStore}
 * (soul + facts) does NOT cover: the *operational* state nanobot kept across
 * `tasks.json` + `cron/jobs.json` + its run history. Lifted into core so every
 * host (desktop sidecar, agent, cli) runs the same autonomous loop — storage
 * and timers are injected (fs/SQLite on Node, AsyncStorage on RN), the logic is
 * pure TS with zero runtime deps.
 *
 * Three pieces:
 *   - TaskStore   — the registry of scheduled/manual tasks (was tasks-store.ts)
 *   - TaskRunLog  — what each task did, when, and what it cost (was agent-state.ts)
 *   - Scheduler   — fires due tasks on their interval (was nanobot cron)
 *
 * Spend safety lives alongside in {@link ./risk}.
 */

/** Capital earmarked for a task — isolates how much a single task may touch. */
export interface TaskAllocation {
  /** Satoshis of BTC the task may spend. */
  btcSat: number;
  /** USDT (display units) the task may spend. */
  usdt: number;
  /** XAUT (display units) the task may spend. */
  xaut: number;
}

/** A zero allocation — the default for read-only / monitoring tasks. */
export const ZERO_ALLOCATION: TaskAllocation = { btcSat: 0, usdt: 0, xaut: 0 };

/**
 * A scheduled (or manual) autonomous task — the unit nanobot stored in
 * `tasks.json`. A task names a skill to run on an interval, with an optional
 * capital budget and an enable switch.
 */
export interface AgentTask {
  id: string;
  name: string;
  description: string;
  /** Skill that scopes the run, e.g. 'portfolio-manager'. */
  skill: string;
  /** Seconds between runs. 0 = manual-only (never auto-fires). */
  scheduleSec: number;
  /** Run once immediately when the scheduler starts. */
  runOnStartup: boolean;
  /** Capital this task is allowed to move. */
  allocation: TaskAllocation;
  enabled: boolean;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms of the last run, or null if never run. */
  lastRunAt: number | null;
}

/**
 * What `create` accepts — id/createdAt/lastRunAt are filled by the store, and
 * allocation/runOnStartup default when omitted.
 */
export type NewTask = Omit<
  AgentTask,
  'id' | 'createdAt' | 'lastRunAt' | 'allocation' | 'runOnStartup'
> &
  Partial<Pick<AgentTask, 'id' | 'createdAt' | 'lastRunAt' | 'allocation' | 'runOnStartup'>>;

/** A default/seed task — carries a stable id so seeding is idempotent. */
export type TaskSeed = NewTask & { id: string };

/** The task registry. Mirrors {@link ../memory/types.MemoryStore}'s shape. */
export interface TaskStore {
  list(): Promise<AgentTask[]>;
  get(id: string): Promise<AgentTask | null>;
  create(input: NewTask): Promise<AgentTask>;
  /** Patch a task. id/createdAt are immutable. Returns null if not found. */
  update(id: string, patch: Partial<Omit<AgentTask, 'id' | 'createdAt'>>): Promise<AgentTask | null>;
  remove(id: string): Promise<boolean>;
  /** Insert any seed whose id isn't already present. Returns the ones added. */
  seedDefaults(seeds: TaskSeed[]): Promise<AgentTask[]>;
}

/** Injected persistence — load once, save on every mutation. */
export interface TaskStoreIO {
  load(): Promise<AgentTask[]>;
  save(tasks: AgentTask[]): Promise<void>;
}

// ── Run history ────────────────────────────────────────────────────────────

/** Token + dollar cost of a single run. */
export interface TaskRunCost {
  usd: number;
  inputTokens: number;
  outputTokens: number;
}

/** Aggregated stats for one task across all its runs. */
export interface TaskStats {
  runs: number;
  errors: number;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastToolCalls: number | null;
  lastError: string | null;
  /** First ~800 chars of the last final response. */
  lastText: string | null;
}

/** One completed run, newest-first in the recent ring buffer. */
export interface TaskRunRecord {
  taskId: string;
  taskName: string;
  /** Epoch ms the run started. */
  startedAt: number;
  durationMs: number;
  toolCalls: number;
  ok: boolean;
  error: string | null;
  /** Final response text (truncated by the log). */
  text: string;
  cost: TaskRunCost;
}

/** A serializable point-in-time view of the run log, for persistence. */
export interface RunLogSnapshot {
  stats: Record<string, TaskStats>;
  recent: TaskRunRecord[];
  cumulative: TaskRunCost;
}

/** Injected persistence for the run log. */
export interface RunLogIO {
  load(): Promise<RunLogSnapshot | null>;
  save(snapshot: RunLogSnapshot): Promise<void>;
}

// ── Scheduler ──────────────────────────────────────────────────────────────

/** The result of running a task once. The host's `run` callback returns this. */
export interface TaskRunOutcome {
  ok: boolean;
  text?: string;
  toolCalls?: number;
  error?: string;
  cost?: Partial<TaskRunCost>;
}

/** Host-provided runner — typically wraps `Funnel.runTurn(buildTaskPrompt(task))`. */
export type RunTask = (task: AgentTask) => Promise<TaskRunOutcome>;

/** Opaque timer handle so the scheduler stays platform-agnostic. */
export type TimerHandle = unknown;

export interface SchedulerOptions {
  store: TaskStore;
  /** Runs a task and resolves with its outcome. Errors are caught by the scheduler. */
  run: RunTask;
  /** Notified after every run (success or error) — wire to a {@link TaskRunLog}. */
  onOutcome?: (task: AgentTask, outcome: TaskRunOutcome, durationMs: number) => void;
  /** Diagnostics sink. Default: silent. */
  log?: (msg: string) => void;
  /** Injectable clock. Default: Date.now. */
  now?: () => number;
  /** How often `start()` evaluates due tasks, ms. Default 30_000. */
  tickMs?: number;
  /** Max tasks running at once. Default 1 (serial — safest for a wallet). */
  concurrency?: number;
  /** Injectable timer. Default: setInterval. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /** Injectable timer-clear. Default: clearInterval. */
  clearTimer?: (handle: TimerHandle) => void;
}

export interface TaskScheduler {
  /** Begin firing due tasks; runs `runOnStartup` tasks immediately. Idempotent. */
  start(): void;
  /** Stop firing. In-flight runs finish; no new ones start. */
  stop(): void;
  /** Evaluate all tasks once and run those that are due. Safe to call directly (tests). */
  tick(): Promise<void>;
  /** Force-run a task now regardless of schedule/enabled. Null if unknown/already running. */
  runNow(id: string): Promise<TaskRunOutcome | null>;
  /** Ids of tasks currently running. */
  active(): string[];
  /** Whether `start()` is in effect. */
  isRunning(): boolean;
}
