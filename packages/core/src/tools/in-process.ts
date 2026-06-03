/**
 * InProcessToolSource — tools whose handlers run in the same process.
 *
 * Used by the mobile wallet: the handlers call the device's wallet adapters
 * (Spark / Arkade / RGB) directly, so signing happens on the phone even when
 * the model's inference is delegated to a desktop over P2P.
 */

import type { ToolDef } from '../types.js';
import type { ToolSource } from './source.js';

export interface InProcessTool<Args = Record<string, unknown>> {
  name: string;
  description: string;
  /** Zod schema (or any shape the provider understands). */
  parameters: unknown;
  /** When true, the engine pauses for confirmation before executing. */
  requiresConfirmation?: boolean;
  handler: (args: Args) => Promise<unknown>;
}

export class InProcessToolSource implements ToolSource {
  readonly id: string;
  private readonly tools = new Map<string, InProcessTool>();

  constructor(id: string, tools: InProcessTool[]) {
    this.id = id;
    for (const t of tools) this.tools.set(t.name, t as InProcessTool);
  }

  listTools(): ToolDef[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      requiresConfirmation: t.requiresConfirmation,
    }));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool "${name}" not found in source "${this.id}"`);
    return tool.handler(args);
  }
}
