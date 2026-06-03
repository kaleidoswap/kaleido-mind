/**
 * ToolRegistry — merges multiple ToolSources into one tool list for the model
 * and routes each tool call back to the source that owns it.
 *
 * Name-clash policy: first source wins (sources are consulted in registration
 * order), so a host can layer a high-priority source over a broader one.
 */

import type { ToolDef } from '../types.js';
import type { ToolSource } from './source.js';

export class ToolRegistry {
  private readonly sources: ToolSource[] = [];

  constructor(sources: ToolSource[] = []) {
    this.sources = [...sources];
  }

  add(source: ToolSource): this {
    this.sources.push(source);
    return this;
  }

  /** Merged, de-duplicated tool list across all sources. */
  async listTools(): Promise<ToolDef[]> {
    const out: ToolDef[] = [];
    const seen = new Set<string>();
    for (const source of this.sources) {
      const tools = await source.listTools();
      for (const t of tools) {
        if (seen.has(t.name)) continue; // first source wins
        seen.add(t.name);
        out.push(t);
      }
    }
    return out;
  }

  /** The first source that owns a tool by name. */
  private ownerOf(name: string): ToolSource | undefined {
    return this.sources.find((s) => s.has(name));
  }

  /** Execute a tool, routing to its owning source. */
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const owner = this.ownerOf(name);
    if (!owner) throw new Error(`No tool source owns "${name}"`);
    return owner.execute(name, args);
  }

  /** Look up a tool definition (e.g. to check requiresConfirmation). */
  async getDef(name: string): Promise<ToolDef | undefined> {
    const tools = await this.listTools();
    return tools.find((t) => t.name === name);
  }
}
