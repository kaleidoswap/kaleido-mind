/**
 * ToolSource — anything that exposes a set of tools and can execute them.
 *
 * This is the seam that makes the engine modular. Two implementations cover
 * every surface:
 *   - InProcessToolSource — Zod tools + local handlers (works on React Native;
 *     used by the mobile wallet — handlers run on-device so keys never leave)
 *   - McpToolSource       — connects an MCP server over stdio/HTTP (Node only;
 *     used on desktop for the full kaleido-mcp toolset)
 *
 * The engine merges N sources into one tool list for the model and routes each
 * tool call back to the source that owns it.
 */

import type { ToolDef } from '../types.js';

export interface ToolSource {
  /** Stable identifier (for logging / debugging). */
  readonly id: string;
  /** The tools this source exposes. May be async (e.g. MCP listTools). */
  listTools(): ToolDef[] | Promise<ToolDef[]>;
  /** Whether this source owns a tool by name. */
  has(name: string): boolean;
  /** Execute a tool this source owns. */
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
}
