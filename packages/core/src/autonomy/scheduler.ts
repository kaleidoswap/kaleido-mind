/**
 * Scheduler — fires due tasks on their interval. Replaces the nanobot cron
 * engine kaleidoagent relied on; here it's pure TS with injectable clock +
 * timers so it's deterministically testable and runs anywhere (no cron daemon).
 *
 * Semantics:
 *   - A task is "due" when enabled, scheduleSec > 0, and at least scheduleSec
 *     has elapsed since its last run (or its creation, if never run). A fresh
 *     task therefore waits one full interval before its first auto-run — unless
 *     runOnStartup is set, in which case start() runs it immediately.
 *   - Runs are serial by default (concurrency 1) — safest for a wallet. A task
 *     never runs concurrently with itself.
 *   - lastRunAt is stamped at the START of a run, so a slow run doesn't shorten
 *     the next interval, and a failing run still advances (no hot-loop).
 */

import type {
  AgentTask,
  SchedulerOptions,
  TaskRunOutcome,
  TaskScheduler,
  TimerHandle,
} from './types.js';

export function createTaskScheduler(opts: SchedulerOptions): TaskScheduler {
  const { store, run } = opts;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const tickMs = opts.tickMs ?? 30_000;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const setTimer = opts.setTimer ?? ((fn, ms) => setInterval(fn, ms) as unknown as TimerHandle);
  const clearTimer = opts.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  const active = new Set<string>();
  let running = false;
  let timer: TimerHandle | undefined;

  function isDue(task: AgentTask, ref: number): boolean {
    if (!task.enabled || task.scheduleSec <= 0) return false;
    const since = ref - (task.lastRunAt ?? task.createdAt);
    return since >= task.scheduleSec * 1000;
  }

  /** Run one task, stamping lastRunAt and reporting the outcome. */
  async function runOne(task: AgentTask): Promise<TaskRunOutcome> {
    active.add(task.id);
    const started = now();
    // Stamp the start time first so a crash mid-run still advances the interval.
    await store.update(task.id, { lastRunAt: started });
    let outcome: TaskRunOutcome;
    try {
      outcome = await run(task);
    } catch (e) {
      outcome = { ok: false, error: (e as Error)?.message ?? String(e) };
    } finally {
      active.delete(task.id);
    }
    const durationMs = now() - started;
    log(`ran ${task.id} ok=${outcome.ok} ${durationMs}ms`);
    opts.onOutcome?.(task, outcome, durationMs);
    return outcome;
  }

  async function tick(): Promise<void> {
    const tasks = await store.list();
    const ref = now();
    const launched: Promise<unknown>[] = [];
    for (const task of tasks) {
      if (active.size >= concurrency) break;
      if (active.has(task.id) || !isDue(task, ref)) continue;
      // active.add (inside runOne) runs synchronously, so the size guard stays
      // accurate as we launch up to `concurrency` runs that overlap each other;
      // we await them so `tick()` resolves only once this batch is done.
      launched.push(runOne(task));
    }
    await Promise.all(launched);
  }

  async function startupPass(): Promise<void> {
    const tasks = await store.list();
    for (const task of tasks) {
      if (task.enabled && task.runOnStartup && !active.has(task.id)) {
        // Serial on startup — predictable ordering, no thundering herd.
        await runOne(task);
      }
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      timer = setTimer(() => {
        void tick();
      }, tickMs);
      log(`scheduler started (tick=${tickMs}ms, concurrency=${concurrency})`);
      void startupPass();
    },
    stop(): void {
      running = false;
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
      log('scheduler stopped');
    },
    tick,
    async runNow(id: string): Promise<TaskRunOutcome | null> {
      const task = await store.get(id);
      if (!task || active.has(id)) return null;
      return runOne(task);
    },
    active(): string[] {
      return [...active];
    },
    isRunning(): boolean {
      return running;
    },
  };
}
