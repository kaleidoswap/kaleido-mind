/**
 * TaskStore implementation — in-memory, with optional injected persistence.
 * Pure TS, zero deps. Port of kaleidoagent's tasks-store.ts, but storage-agnostic
 * (host injects IO: fs on a Node sidecar, SQLite on the desktop, AsyncStorage on RN).
 *
 *   const store = new InMemoryTaskStore();          // ephemeral
 *   const store = new InMemoryTaskStore({ io });     // persisted
 */

import {
  ZERO_ALLOCATION,
  type AgentTask,
  type NewTask,
  type TaskSeed,
  type TaskStore,
  type TaskStoreIO,
} from './types.js';

export interface TaskStoreOptions {
  /** Persistence (load on first use, save on writes). Omit for ephemeral tasks. */
  io?: TaskStoreIO;
  /** Clock — injectable for deterministic tests. */
  now?: () => number;
}

export class InMemoryTaskStore implements TaskStore {
  private tasks: AgentTask[] = [];
  private hydrated = false;
  private counter = 0;
  private readonly io?: TaskStoreIO;
  private readonly now: () => number;

  constructor(opts: TaskStoreOptions = {}) {
    this.io = opts.io;
    this.now = opts.now ?? (() => Date.now());
  }

  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    if (this.io) {
      try {
        this.tasks = await this.io.load();
        this.counter = this.tasks.length;
      } catch {
        this.tasks = [];
      }
    }
  }

  private async persist(): Promise<void> {
    if (this.io) await this.io.save(this.tasks);
  }

  async list(): Promise<AgentTask[]> {
    await this.hydrate();
    return [...this.tasks];
  }

  async get(id: string): Promise<AgentTask | null> {
    await this.hydrate();
    return this.tasks.find((t) => t.id === id) ?? null;
  }

  async create(input: NewTask): Promise<AgentTask> {
    await this.hydrate();
    const task = this.materialize(input);
    this.tasks.push(task);
    await this.persist();
    return task;
  }

  async update(
    id: string,
    patch: Partial<Omit<AgentTask, 'id' | 'createdAt'>>,
  ): Promise<AgentTask | null> {
    await this.hydrate();
    const existing = this.tasks.find((t) => t.id === id);
    if (!existing) return null;
    // id + createdAt are immutable; strip them defensively even if cast in.
    const { id: _id, createdAt: _createdAt, ...safe } = patch as Partial<AgentTask>;
    const updated: AgentTask = { ...existing, ...safe };
    this.tasks = this.tasks.map((t) => (t.id === id ? updated : t));
    await this.persist();
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    await this.hydrate();
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    const removed = this.tasks.length < before;
    if (removed) await this.persist();
    return removed;
  }

  async seedDefaults(seeds: TaskSeed[]): Promise<AgentTask[]> {
    await this.hydrate();
    const present = new Set(this.tasks.map((t) => t.id));
    const added = seeds
      .filter((s) => !present.has(s.id))
      .map((s) => this.materialize(s));
    if (added.length) {
      // Seeds first, so the default loops sort to the top of the list.
      this.tasks = [...added, ...this.tasks];
      await this.persist();
    }
    return added;
  }

  /** Fill defaults + assign id/createdAt for a new or seed task. */
  private materialize(input: NewTask): AgentTask {
    return {
      id: input.id ?? `task_${this.now()}_${++this.counter}`,
      name: input.name,
      description: input.description,
      skill: input.skill,
      scheduleSec: input.scheduleSec,
      runOnStartup: input.runOnStartup ?? false,
      allocation: input.allocation ?? { ...ZERO_ALLOCATION },
      enabled: input.enabled,
      createdAt: input.createdAt ?? this.now(),
      lastRunAt: input.lastRunAt ?? null,
    };
  }
}

/**
 * The three default loops nanobot seeded — ready to pass to `seedDefaults`.
 * Disabled by default: a wallet agent must be turned on deliberately, never
 * auto-arm itself on first launch.
 */
export function defaultTaskSeeds(opts: {
  heartbeatSec?: number;
  rebalanceSec?: number;
  dailySummarySec?: number;
} = {}): TaskSeed[] {
  return [
    {
      id: 'heartbeat',
      name: 'Heartbeat',
      description: 'Node health check, channel audit, RGB transfer flush',
      skill: 'channel-manager',
      scheduleSec: opts.heartbeatSec ?? 300,
      runOnStartup: true,
      enabled: false,
    },
    {
      id: 'rebalance',
      name: 'Portfolio Rebalance',
      description: 'Detect allocation drift and execute rebalancing swaps',
      skill: 'portfolio-manager',
      scheduleSec: opts.rebalanceSec ?? 3600,
      runOnStartup: false,
      enabled: false,
    },
    {
      id: 'daily_summary',
      name: 'Daily Summary',
      description: 'Full portfolio snapshot and market report',
      skill: 'portfolio-manager',
      scheduleSec: opts.dailySummarySec ?? 86_400,
      runOnStartup: false,
      enabled: false,
    },
  ];
}
