/**
 * McpToolSource — exposes an MCP server's tools to the engine. NODE ONLY.
 *
 * Not exported from the package's main entry (`@kaleido/mind`) — import it
 * explicitly from `@kaleido/mind/mcp` on Node hosts (desktop-app, kaleidoagent)
 * so React Native never bundles the MCP SDK or any subprocess machinery.
 *
 * Connects to a server like `kaleido-mcp` (Spark + RLN + KaleidoSwap DEX +
 * MPP/L402 + market data, ~64 tools) over stdio or HTTP, lists its tools, and
 * routes execute() calls through the MCP client.
 *
 * The `@modelcontextprotocol/sdk` dependency is imported dynamically so this
 * file type-checks and ships even where the SDK isn't installed; constructing
 * an McpToolSource without it throws a clear error.
 *
 * Wired end-to-end: connect() (stdio + HTTP transports), listTools() and
 * execute() are implemented. Used by the desktop sidecar (kaleido-mcp +
 * Bitrefill MCP) and verified against the remote Bitrefill MCP.
 */

import type { ToolDef } from '../types.js';
import type { ToolSource } from './source.js';
import { isKaleidoswapSpendTool } from '../kaleidoswap/contract.js';
import { isLsps1SpendTool } from '../lsps1/contract.js';
import { isSpendTool } from '../wallet/contract.js';

function toolRequiresConfirmation(name: string, description: string): boolean {
  return (
    isSpendTool(name) ||
    isKaleidoswapSpendTool(name) ||
    isLsps1SpendTool(name) ||
    /\bSPEND\b.*\bconfirm/i.test(description)
  );
}

export type McpTransport =
  | { kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { kind: 'http'; url: string; headers?: Record<string, string> };

export interface McpToolSourceOptions {
  id: string;
  transport: McpTransport;
  /** Optional allowlist — only expose these tool names if provided. */
  allow?: string[];
  /** Per-call timeout (ms). Default 60_000. */
  timeoutMs?: number;
}

export class McpToolSource implements ToolSource {
  readonly id: string;
  private readonly opts: McpToolSourceOptions;
  private client: any | null = null;
  private tools: ToolDef[] = [];

  constructor(opts: McpToolSourceOptions) {
    this.id = opts.id;
    this.opts = opts;
  }

  /** Connect to the MCP server and cache its tool list. Call once at startup. */
  async connect(): Promise<void> {
    // Dynamic import keeps the MCP SDK out of bundles that never call connect().
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const t = this.opts.transport;

    let transport: any;
    if (t.kind === 'stdio') {
      const { StdioClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/stdio.js'
      );
      transport = new StdioClientTransport({ command: t.command, args: t.args ?? [], env: t.env });
    } else {
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      );
      transport = new StreamableHTTPClientTransport(new URL(t.url), {
        requestInit: t.headers ? { headers: t.headers } : undefined,
      });
    }

    this.client = new Client({ name: `kaleido-mind:${this.id}`, version: '0.0.1' }, { capabilities: {} });
    await this.client.connect(transport);

    const listed = await this.client.listTools();
    const allow = this.opts.allow ? new Set(this.opts.allow) : null;
    this.tools = (listed.tools ?? [])
      .filter((t: any) => !allow || allow.has(t.name))
      .map((t: any) => ({
        name: t.name,
        description: t.description ?? '',
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
        requiresConfirmation: toolRequiresConfirmation(t.name, t.description ?? ''),
      }));
  }

  listTools(): ToolDef[] {
    return this.tools;
  }

  has(name: string): boolean {
    return this.tools.some((t) => t.name === name);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error(`McpToolSource "${this.id}" not connected — call connect() first`);
    const res = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: this.opts.timeoutMs ?? 60_000 },
    );
    // MCP returns content blocks; surface text content as the tool result.
    if (Array.isArray(res?.content)) {
      const text = res.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
      return text || res.content;
    }
    return res;
  }

  async close(): Promise<void> {
    await this.client?.close?.();
    this.client = null;
  }
}
