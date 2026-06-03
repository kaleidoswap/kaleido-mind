/**
 * @kaleido/mind — shared local-AI reasoning engine for KaleidoSwap.
 *
 * Pure TypeScript, zero runtime dependencies. Hosts inject:
 *   - an LLMProvider (wrapping @qvac/sdk, Anthropic, …)
 *   - one or more ToolSources (in-process wallet tools, MCP servers, …)
 *
 * and get the shared agentic loop, identical on mobile / desktop / agent.
 */

export type {
  Role,
  Message,
  ToolDef,
  ToolCall,
  ToolResult,
  ConfirmDecision,
} from './types.js';

export type { LLMProvider, TurnInput, TurnOutput } from './providers/types.js';

export type { ToolSource } from './tools/source.js';
export { InProcessToolSource } from './tools/in-process.js';
export type { InProcessTool } from './tools/in-process.js';
export { ToolRegistry } from './tools/registry.js';
export {
  createL402ToolSource,
  parseL402Challenge,
  bolt11AmountSats,
} from './tools/l402.js';
export type { L402Options, L402PayResult } from './tools/l402.js';

export { Engine } from './engine.js';
export type { EngineOptions, AgenticOptions, AgenticResult } from './engine.js';

export { TurnLogger, defaultMask } from './logger.js';
export type { TurnLog, Device, LoggerIO, LoggerOptions } from './logger.js';
