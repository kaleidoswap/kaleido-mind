/**
 * Autonomy — the agent's task brain: a registry of scheduled tasks (TaskStore),
 * the record of what they did (TaskRunLog), an interval engine that fires them
 * (createTaskScheduler), and enforced spend guardrails (evaluateSpend).
 *
 * This is the half of the agent's memory the MemoryStore (soul + facts) doesn't
 * cover — the operational state nanobot kept in tasks.json + cron + run history.
 * Storage and timers are injected; the logic is pure TS.
 */

export type {
  TaskAllocation,
  AgentTask,
  NewTask,
  TaskSeed,
  TaskStore,
  TaskStoreIO,
  TaskRunCost,
  TaskStats,
  TaskRunRecord,
  RunLogSnapshot,
  RunLogIO,
  TaskRunOutcome,
  RunTask,
  TimerHandle,
  SchedulerOptions,
  TaskScheduler,
} from './types.js';
export { ZERO_ALLOCATION } from './types.js';

export { InMemoryTaskStore, defaultTaskSeeds } from './task-store.js';
export type { TaskStoreOptions } from './task-store.js';

export { TaskRunLog } from './run-state.js';
export type { RunLogOptions } from './run-state.js';

export { createTaskScheduler } from './scheduler.js';

export { evaluateSpend, DEFAULT_RISK_LIMITS } from './risk.js';
export type {
  SpendKind,
  RiskLimits,
  SpendAction,
  RiskContext,
  RiskOutcome,
  RiskVerdict,
} from './risk.js';

export { buildTaskPrompt } from './prompt.js';
export type { TaskPromptOptions } from './prompt.js';
