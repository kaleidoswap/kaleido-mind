/**
 * McpToolSource — exposes an MCP server's tools to the engine. NODE ONLY.
 *
 * Not exported from the package's main entry (`@kaleidorg/mind`) — import it
 * explicitly from `@kaleidorg/mind/mcp` on Node hosts (desktop-app, kaleidoagent)
 * so React Native never bundles the MCP SDK or any subprocess machinery.
 *
 * Connects to a server like `kaleido-mcp` (Spark + RLN + KaleidoSwap DEX +
 * MPP/L402 + market data; catalog varies by configuration) over stdio or HTTP, lists its tools, and
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

// Wire operations absent from the in-process wallet contract. Do not infer
// permission from a model-facing description alone.
const MCP_SENSITIVE_TOOLS = new Set([
  'sendTransaction', 'transfer', 'sign',
  'spark_pay_lightning_invoice', 'spark_send_sats', 'spark_transfer_token',
  'spark_withdraw', 'spark_pay_spark_invoice', 'spark_mpp_pay',
  'liquid_send_btc', 'liquid_send_asset', 'rln_mpp_pay',
  'kaleidoswap_submarine_fund',
  'kaleido_node_up', 'kaleido_node_stop', 'kaleido_node_down',
  'kaleido_node_use', 'kaleido_node_init', 'kaleido_node_unlock', 'kaleido_node_lock',
]);

export function toolRequiresConfirmation(name: string, description: string): boolean {
  return (
    isSpendTool(name) ||
    isSpendTool(name.replace(/^wdk_/, 'rln_')) ||
    MCP_SENSITIVE_TOOLS.has(name.replace(/^wdk_/, 'rln_')) ||
    isKaleidoswapSpendTool(name) ||
    isLsps1SpendTool(name) ||
    // kaleido-mcp names the LSPS1 tools with a kaleidoswap_ prefix.
    isLsps1SpendTool(name.replace(/^kaleidoswap_/, '')) ||
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
  /** Optional prefix allowlist: when non-empty, only tools whose name starts with one of these are exposed. */
  allowPrefixes?: string[];
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
  private wireNames = new Map<string, string>();

  constructor(opts: McpToolSourceOptions) {
    this.id = opts.id;
    this.opts = opts;
  }

  /** Connect to the MCP server and cache its tool list. Call once at startup. */
  async connect(): Promise<void> {
    if (this.client) throw new Error(`McpToolSource "${this.id}" is already connected`);
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
    try {
      await this.client.connect(transport);

      const discovered: any[] = [];
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = await this.client.listTools(cursor ? { cursor } : {});
        discovered.push(...(page.tools ?? []));
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('MCP tools pagination repeated a cursor');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      // Kaleido MCP uses spark_pay_invoice for Spark invoices, whereas Mind's
      // wallet contract reserves it for BOLT11. Preserve the Spark operation under
      // its explicit alias and route the canonical Mind name to the BOLT11 tool.
      const sparkWire = discovered.find(t => t.name === 'spark_pay_invoice');
      const adaptSpark = !!sparkWire?.inputSchema?.properties?.invoices
        && discovered.some(t => t.name === 'spark_pay_lightning_invoice');
      const normalized = discovered.filter(t => !(adaptSpark && t.name === 'spark_pay_invoice'));
      if (adaptSpark && !normalized.some(t => t.name === 'spark_pay_spark_invoice')) {
        normalized.push({ ...sparkWire, name: 'spark_pay_spark_invoice', wireName: 'spark_pay_invoice' });
      }
      if (adaptSpark) {
        const lightning = discovered.find(t => t.name === 'spark_pay_lightning_invoice');
        normalized.push({ ...lightning, name: 'spark_pay_invoice', wireName: lightning.name });
      }
      this.wireNames.clear();
      const allow = this.opts.allow ? new Set(this.opts.allow) : null;
      const denied = this.opts.denyPrefixes ?? [];
      const allowedPrefixes = this.opts.allowPrefixes ?? [];
      this.tools = normalized
        .filter((t: any) => !allow || allow.has(t.name))
        .filter((t: any) => !allowedPrefixes.length || allowedPrefixes.some((prefix) => t.name.startsWith(prefix)))
        .filter((t: any) => !denied.some((prefix) => t.name.startsWith(prefix)))
        .map((t: any) => {
          this.wireNames.set(t.name, t.wireName ?? t.name);
          return {
            name: t.name,
            description: t.description ?? '',
            parameters: t.inputSchema ?? { type: 'object', properties: {} },
            requiresConfirmation: toolRequiresConfirmation(t.name, t.description ?? ''),
          };
        });
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  listTools(): ToolDef[] {
    return this.tools;
  }

  has(name: string): boolean {
    return this.tools.some((t) => t.name === name);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error(`McpToolSource "${this.id}" not connected — call connect() first`);
    if (!this.has(name)) throw new Error(`Tool "${name}" is not exposed by McpToolSource "${this.id}"`);
    const wireName = this.wireNames.get(name) ?? name;
    if (name === 'spark_pay_invoice' && wireName === 'spark_pay_lightning_invoice' && args.amount_sats !== undefined) {
      const parameters = this.tools.find(t => t.name === name)?.parameters as { properties?: Record<string, unknown> };
      if (!parameters?.properties?.amount_sats) throw new Error('This MCP Lightning payer does not support amount_sats overrides; use an invoice with an encoded amount.');
    }
    const res = await this.client.callTool(
      { name: wireName, arguments: args },
      undefined,
      { timeout: this.opts.timeoutMs ?? 60_000 },
    );
    // Parse JSON + surface isError so recipes/agent get structured results and
    // real failures (not an opaque string that hid both). See parseMcpResult.
    return parseMcpResult(res);
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.tools = [];
    this.wireNames.clear();
    await client?.close?.();
  }
}
