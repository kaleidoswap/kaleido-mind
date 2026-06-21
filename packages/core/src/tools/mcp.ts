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
  /** Optional prefix denylist applied after discovery (for host-specific rails). */
  denyPrefixes?: string[];
  /** Per-call timeout (ms). Default 60_000. */
  timeoutMs?: number;
}

/**
 * Normalize an MCP `callTool` result into a structured value.
 *
 * Two fixes vs. returning the raw text content:
 *  - `isError` (the MCP failure signal) becomes an `{ error }` object, so callers
 *    — the recipe runner's `toolFailure`, the agent — treat it as a FAILURE
 *    instead of a successful result. Without this the agent claimed a spend had
 *    succeeded when the wallet actually rejected it.
 *  - JSON text is PARSED, so recipes thread real fields (rfq_id, total_sat,
 *    order_id) and any failure fields (error/status) are visible. A raw string
 *    hid both — the quote's rfq_id never reached the create call, and the canned
 *    success summary fired regardless. Non-JSON text passes through unchanged;
 *    the engine re-stringifies objects when feeding the model.
 *
 * Exported for unit testing.
 */
export function parseMcpResult(res: unknown): unknown {
  const r = res as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | null;
  const text = Array.isArray(r?.content)
    ? r!.content
        .filter((c) => c?.type === 'text')
        .map((c) => c?.text ?? '')
        .join('\n')
    : '';
  if (r?.isError) return { error: text || 'The tool reported an error.' };
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return Array.isArray(r?.content) ? r!.content : res;
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
    const denied = this.opts.denyPrefixes ?? [];
    this.tools = (listed.tools ?? [])
      .filter((t: any) => !allow || allow.has(t.name))
      .filter((t: any) => !denied.some((prefix) => t.name.startsWith(prefix)))
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
    // Parse JSON + surface isError so recipes/agent get structured results and
    // real failures (not an opaque string that hid both). See parseMcpResult.
    return parseMcpResult(res);
  }

  async close(): Promise<void> {
    await this.client?.close?.();
    this.client = null;
  }
}
