/** Autonomy tests — deterministic: injected clock + timer, no real wallet/LLM. */

import { describe, it, expect, vi } from 'vitest';
import { InMemoryTaskStore, defaultTaskSeeds } from './task-store.js';
import { createTaskScheduler } from './scheduler.js';
import { TaskRunLog } from './run-state.js';
import { evaluateSpend, DEFAULT_RISK_LIMITS } from './risk.js';
import { buildTaskPrompt } from './prompt.js';
import type { AgentTask, RunLogSnapshot, RunLogIO, TaskStoreIO } from './types.js';

const SEC = 1000;

/** Drain pending microtasks (real timer — these tests don't fake setTimeout). */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('InMemoryTaskStore', () => {
  it('creates with defaults and lists', async () => {
    const store = new InMemoryTaskStore({ now: () => 1 });
    const t = await store.create({
      name: 'Rebalance',
      description: 'd',
      skill: 'portfolio-manager',
      scheduleSec: 3600,
      enabled: true,
    });
    expect(t.id).toBe('task_1_1');
    expect(t.runOnStartup).toBe(false);
    expect(t.allocation).toEqual({ btcSat: 0, usdt: 0, xaut: 0 });
    expect(t.lastRunAt).toBeNull();
    expect(await store.list()).toHaveLength(1);
  });

  it('update cannot mutate id/createdAt; remove works', async () => {
    const store = new InMemoryTaskStore({ now: () => 5 });
    const t = await store.create({ name: 'x', description: '', skill: 's', scheduleSec: 0, enabled: false });
    const patched = await store.update(t.id, {
      enabled: true,
      lastRunAt: 99,
      // @ts-expect-error — id is not patchable, proving the type guard
      id: 'evil',
    } as Partial<AgentTask>);
    expect(patched?.id).toBe(t.id);
    expect(patched?.createdAt).toBe(5);
    expect(patched?.enabled).toBe(true);
    expect(patched?.lastRunAt).toBe(99);
    expect(await store.remove(t.id)).toBe(true);
    expect(await store.remove(t.id)).toBe(false);
  });

  it('seedDefaults is idempotent by id', async () => {
    const store = new InMemoryTaskStore({ now: () => 1 });
    const first = await store.seedDefaults(defaultTaskSeeds());
    expect(first.map((t) => t.id)).toEqual(['heartbeat', 'rebalance', 'daily_summary']);
    const second = await store.seedDefaults(defaultTaskSeeds());
    expect(second).toHaveLength(0); // already present
    expect(await store.list()).toHaveLength(3);
    // seeds disabled by default — an agent never auto-arms itself
    expect((await store.list()).every((t) => !t.enabled)).toBe(true);
  });

  it('persists through injected IO and a fresh store hydrates', async () => {
    let saved: AgentTask[] = [];
    const io: TaskStoreIO = {
      load: vi.fn(async () => [...saved]),
      save: vi.fn(async (tasks) => {
        saved = [...tasks];
      }),
    };
    const store = new InMemoryTaskStore({ io, now: () => 1 });
    await store.create({ name: 'a', description: '', skill: 's', scheduleSec: 60, enabled: true });
    expect(io.save).toHaveBeenCalled();

    const store2 = new InMemoryTaskStore({ io, now: () => 2 });
    expect(await store2.list()).toHaveLength(1);
  });
});

describe('createTaskScheduler', () => {
  function fixtureTask(over: Partial<AgentTask> = {}): AgentTask {
    return {
      id: 't1',
      name: 'Heartbeat',
      description: '',
      skill: 'channel-manager',
      scheduleSec: 300,
      runOnStartup: false,
      allocation: { btcSat: 0, usdt: 0, xaut: 0 },
      enabled: true,
      createdAt: 0,
      lastRunAt: null,
      ...over,
    };
  }

  it('runs a task only once its interval has elapsed since creation', async () => {
    let t = 0;
    const store = new InMemoryTaskStore({ now: () => t });
    await store.create(fixtureTask());
    const run = vi.fn(async () => ({ ok: true }));
    const sched = createTaskScheduler({ store, run, now: () => t });

    t = 200 * SEC; // < 300s since createdAt=0 → not due
    await sched.tick();
    expect(run).not.toHaveBeenCalled();

    t = 300 * SEC; // exactly due
    await sched.tick();
    expect(run).toHaveBeenCalledTimes(1);
    // lastRunAt stamped at run start
    expect((await store.get('t1'))?.lastRunAt).toBe(300 * SEC);

    t = 400 * SEC; // < 300s since last run → not due again
    await sched.tick();
    expect(run).toHaveBeenCalledTimes(1);

    t = 600 * SEC; // 300s elapsed → due
    await sched.tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('skips disabled tasks and scheduleSec=0 (manual-only)', async () => {
    const store = new InMemoryTaskStore({ now: () => 0 });
    await store.create(fixtureTask({ id: 'off', enabled: false, createdAt: 0 }));
    await store.create(fixtureTask({ id: 'manual', scheduleSec: 0, createdAt: 0 }));
    const run = vi.fn(async () => ({ ok: true }));
    const sched = createTaskScheduler({ store, run, now: () => 10 ** 9 });
    await sched.tick();
    expect(run).not.toHaveBeenCalled();
  });

  it('start() runs runOnStartup tasks immediately via injected timer', async () => {
    const store = new InMemoryTaskStore({ now: () => 0 });
    await store.create(fixtureTask({ id: 'boot', runOnStartup: true, createdAt: 0 }));
    const run = vi.fn(async () => ({ ok: true }));
    const setTimer = vi.fn(() => 'h');
    const clearTimer = vi.fn();
    const sched = createTaskScheduler({ store, run, now: () => 0, setTimer, clearTimer });

    sched.start();
    expect(setTimer).toHaveBeenCalledTimes(1);
    await flush(); // let the async startup pass settle
    expect(run).toHaveBeenCalledTimes(1);
    expect(sched.isRunning()).toBe(true);

    sched.stop();
    expect(clearTimer).toHaveBeenCalledWith('h');
    expect(sched.isRunning()).toBe(false);
  });

  it('runNow forces a run regardless of schedule/enabled and reports outcome', async () => {
    const store = new InMemoryTaskStore({ now: () => 0 });
    await store.create(fixtureTask({ id: 'x', enabled: false, scheduleSec: 0 }));
    const run = vi.fn(async () => ({ ok: true, text: 'done', toolCalls: 2 }));
    const sched = createTaskScheduler({ store, run, now: () => 42 });
    const outcome = await sched.runNow('x');
    expect(outcome).toEqual({ ok: true, text: 'done', toolCalls: 2 });
    expect((await store.get('x'))?.lastRunAt).toBe(42);
    expect(await sched.runNow('nope')).toBeNull();
  });

  it('advances lastRunAt even when the run throws (no hot-loop)', async () => {
    let t = 10 ** 6;
    const store = new InMemoryTaskStore({ now: () => t });
    await store.create(fixtureTask({ id: 'boom', createdAt: 0 }));
    const onOutcome = vi.fn();
    const run = vi.fn(async () => {
      throw new Error('rpc down');
    });
    const sched = createTaskScheduler({ store, run, now: () => t, onOutcome });
    await sched.tick();
    expect((await store.get('boom'))?.lastRunAt).toBe(t);
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'boom' }),
      expect.objectContaining({ ok: false, error: 'rpc down' }),
      expect.any(Number),
    );
  });

  it('honors concurrency=1 — a slow task does not overlap itself', async () => {
    let t = 10 ** 6;
    const store = new InMemoryTaskStore({ now: () => t });
    await store.create(fixtureTask({ id: 'a', createdAt: 0 }));
    await store.create(fixtureTask({ id: 'b', createdAt: 0 }));
    let resolveA: (() => void) | null = null;
    const run = vi.fn((task: AgentTask) =>
      task.id === 'a'
        ? new Promise<{ ok: boolean }>((res) => {
            resolveA = () => res({ ok: true });
          })
        : Promise.resolve({ ok: true }),
    );
    const sched = createTaskScheduler({ store, run, now: () => t, concurrency: 1 });
    void sched.tick();
    await flush();
    // a is in-flight (its run never resolves); concurrency 1 holds b off this tick
    expect(sched.active()).toEqual(['a']);
    expect(run).toHaveBeenCalledTimes(1);
    resolveA?.();
  });
});

describe('TaskRunLog', () => {
  it('aggregates stats, recent runs, and cumulative cost', async () => {
    const log = new TaskRunLog({ now: () => 1, maxRecent: 2 });
    await log.record({
      taskId: 'r', taskName: 'Rebalance', startedAt: 100, durationMs: 5, toolCalls: 3,
      ok: true, error: null, text: 'ok', cost: { usd: 0.01, inputTokens: 10, outputTokens: 5 },
    });
    await log.record({
      taskId: 'r', taskName: 'Rebalance', startedAt: 200, durationMs: 7, toolCalls: 1,
      ok: false, error: 'boom', text: '', cost: { usd: 0.02, inputTokens: 4, outputTokens: 2 },
    });
    const s = await log.statsFor('r');
    expect(s?.runs).toBe(2);
    expect(s?.errors).toBe(1);
    expect(s?.lastError).toBe('boom');
    expect(await log.totalCost()).toEqual({ usd: 0.03, inputTokens: 14, outputTokens: 7 });
    expect((await log.recent()).map((r) => r.startedAt)).toEqual([200, 100]); // newest first
  });

  it('caps the recent ring buffer at maxRecent', async () => {
    const log = new TaskRunLog({ now: () => 1, maxRecent: 2 });
    for (let i = 0; i < 5; i++) {
      await log.record({
        taskId: 't', taskName: 'T', startedAt: i, durationMs: 1, toolCalls: 0,
        ok: true, error: null, text: '', cost: { usd: 0, inputTokens: 0, outputTokens: 0 },
      });
    }
    expect(await log.recent()).toHaveLength(2);
  });

  it('persists + hydrates through injected IO', async () => {
    let snap: RunLogSnapshot | null = null;
    const io: RunLogIO = {
      load: vi.fn(async () => snap),
      save: vi.fn(async (s) => {
        snap = s;
      }),
    };
    const log = new TaskRunLog({ io, now: () => 1 });
    await log.record({
      taskId: 't', taskName: 'T', startedAt: 1, durationMs: 1, toolCalls: 0,
      ok: true, error: null, text: 'hello', cost: { usd: 1, inputTokens: 0, outputTokens: 0 },
    });
    expect(io.save).toHaveBeenCalled();
    const log2 = new TaskRunLog({ io, now: () => 2 });
    expect((await log2.totalCost()).usd).toBe(1);
  });
});

describe('evaluateSpend (risk guardrails)', () => {
  const live = { ...DEFAULT_RISK_LIMITS, dryRun: false };

  it('blocks every spend when dry-run is on', () => {
    const v = evaluateSpend({ kind: 'swap', amountUsd: 1 }, DEFAULT_RISK_LIMITS);
    expect(v.outcome).toBe('block');
    expect(v.reason).toMatch(/dry-run/);
  });

  it('blocks at/below the stop-loss floor', () => {
    const v = evaluateSpend(
      { kind: 'pay', amountSat: 1 },
      { ...live, stopLossBtcSat: 50_000 },
      { btcBalanceSat: 50_000 },
    );
    expect(v.outcome).toBe('block');
    expect(v.reason).toMatch(/stop-loss/);
  });

  it('blocks a spend that would dip below the reserve', () => {
    const v = evaluateSpend(
      { kind: 'send', amountSat: 60_000 },
      { ...live, minBtcReserveSat: 50_000, stopLossBtcSat: 0 },
      { btcBalanceSat: 100_000 },
    );
    expect(v.outcome).toBe('block');
    expect(v.reason).toMatch(/reserve/);
  });

  it('blocks above the max single spend', () => {
    const v = evaluateSpend({ kind: 'swap', amountUsd: 100 }, { ...live, maxSpendUsd: 50 });
    expect(v.outcome).toBe('block');
    expect(v.reason).toMatch(/exceeds/);
  });

  it('blocks a new swap when the open-order cap is reached', () => {
    const v = evaluateSpend(
      { kind: 'swap', amountUsd: 1 },
      { ...live, maxOpenOrders: 3, autoApproveUnderUsd: 100 },
      { openOrders: 3 },
    );
    expect(v.outcome).toBe('block');
    expect(v.reason).toMatch(/open orders/);
  });

  it('auto-approves a small spend under the threshold', () => {
    const v = evaluateSpend(
      { kind: 'pay', amountUsd: 2, amountSat: 3000 },
      { ...live, autoApproveUnderUsd: 5, maxSpendUsd: 50, minBtcReserveSat: 0, stopLossBtcSat: 0 },
      { btcBalanceSat: 1_000_000 },
    );
    expect(v.outcome).toBe('allow');
    expect(v.requiresConfirmation).toBe(false);
  });

  it('requires confirmation above the auto-approve threshold', () => {
    const v = evaluateSpend(
      { kind: 'swap', amountUsd: 20 },
      { ...live, autoApproveUnderUsd: 5, maxSpendUsd: 50 },
    );
    expect(v.outcome).toBe('confirm');
    expect(v.requiresConfirmation).toBe(true);
  });

  it('requires confirmation when the USD value is unknown (never spends blind)', () => {
    const v = evaluateSpend({ kind: 'channel' }, { ...live, autoApproveUnderUsd: 100 });
    expect(v.outcome).toBe('confirm');
  });
});

describe('buildTaskPrompt', () => {
  const task: AgentTask = {
    id: 'rebalance',
    name: 'Portfolio Rebalance',
    description: 'detect drift',
    skill: 'portfolio-manager',
    scheduleSec: 3600,
    runOnStartup: false,
    allocation: { btcSat: 100, usdt: 5, xaut: 0 },
    enabled: true,
    createdAt: 0,
    lastRunAt: null,
  };

  it('embeds skill, dry-run flag, allocation, and the strict-JSON contract', () => {
    const p = buildTaskPrompt(task, { dryRun: true, nowIso: '2026-06-19T00:00:00.000Z' });
    expect(p).toMatch(/portfolio-manager/);
    expect(p).toMatch(/dry_run: true/);
    expect(p).toMatch(/Do NOT pay, send, swap/);
    expect(p).toMatch(/"task":"rebalance"/);
    expect(p).toMatch(/"btcSat":100/);
  });

  it('switches guidance to fund-safety language when live', () => {
    const p = buildTaskPrompt(task, { dryRun: false, nowIso: '2026-06-19T00:00:00.000Z' });
    expect(p).toMatch(/reserve or stop-loss/);
  });
});
