import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../engine.js';
import { ToolRegistry } from './registry.js';
import { scriptedProvider } from '../testing/scripted-provider.js';
import { McpToolSource, toolRequiresConfirmation } from './mcp.js';

const wire = vi.hoisted(() => ({ listTools: vi.fn(), callTool: vi.fn(), close: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class {
  connect = vi.fn(); listTools = wire.listTools; callTool = wire.callTool; close = wire.close;
} }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class {} }));
const def = (name: string, properties = {}) => ({ name, description: '', inputSchema: { type: 'object', properties } });

describe('MCP compatibility and permissions', () => {
  it.each(['pay_invoice', 'send_btc', 'send_asset', 'open_channel', 'close_channel', 'atomic_taker', 'issue_asset', 'create_utxos', 'mpp_pay'])('gates both RLN aliases for %s', name => {
    expect(toolRequiresConfirmation(`wdk_${name}`, '')).toBe(true);
    expect(toolRequiresConfirmation(`rln_${name}`, '')).toBe(true);
  });
  it.each(['spark_pay_lightning_invoice', 'spark_send_sats', 'spark_transfer_token', 'spark_withdraw', 'spark_pay_spark_invoice', 'spark_mpp_pay', 'liquid_send_btc', 'liquid_send_asset', 'sendTransaction', 'transfer', 'sign', 'kaleidoswap_submarine_fund', 'kaleido_node_unlock', 'kaleido_node_down'])('gates %s without relying on prose', name => {
    expect(toolRequiresConfirmation(name, '')).toBe(true);
  });
  it.each(['wdk_get_balances', 'rln_list_assets', 'spark_quote_withdraw', 'liquid_get_balance', 'kaleido_node_status'])('keeps %s read-only', name => {
    expect(toolRequiresConfirmation(name, '')).toBe(false);
  });
  it.each(['wdk_pay_invoice', 'spark_send_sats', 'liquid_send_asset', 'rln_mpp_pay'])('blocks an actual engine call to %s without approval', async name => {
    wire.listTools.mockReset().mockResolvedValue({ tools: [def(name)] });
    wire.callTool.mockReset();
    const source = new McpToolSource({ id: 'test', transport: { kind: 'stdio', command: 'unused' } });
    await source.connect();
    const engine = new Engine({ provider: scriptedProvider([{ tool: name, args: {} }]), tools: new ToolRegistry([source]) });
    const result = await engine.runAgentic([{ role: 'user', content: 'run the operation' }]);
    expect(result.toolCalls).toHaveLength(1);
    expect(wire.callTool).not.toHaveBeenCalled();
    await source.close();
  });
  it('discovers all pages and sends BOLT11 and Spark payments to distinct wire tools', async () => {
    wire.listTools.mockReset().mockResolvedValueOnce({ tools: [def('spark_pay_invoice', { invoices: { type: 'array' } })], nextCursor: 'page2' })
      .mockResolvedValueOnce({ tools: [def('spark_pay_lightning_invoice', { invoice: { type: 'string' } })] });
    wire.callTool.mockReset().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
    const source = new McpToolSource({ id: 'test', transport: { kind: 'stdio', command: 'unused' } });
    await source.connect();
    expect(wire.listTools).toHaveBeenLastCalledWith({ cursor: 'page2' });
    expect(source.listTools().find(t => t.name === 'spark_pay_invoice')?.parameters).toMatchObject({ properties: { invoice: { type: 'string' } } });
    await expect(source.execute('spark_pay_invoice', { invoice: 'lnbc-test', amount_sats: 123 })).rejects.toThrow('does not support');
    await source.execute('spark_pay_invoice', { invoice: 'lnbc-test' });
    expect(wire.callTool).toHaveBeenLastCalledWith({ name: 'spark_pay_lightning_invoice', arguments: { invoice: 'lnbc-test' } }, undefined, { timeout: 60000 });
    await source.execute('spark_pay_spark_invoice', { invoices: [{ invoice: 'spark1-test' }] });
    expect(wire.callTool).toHaveBeenLastCalledWith({ name: 'spark_pay_invoice', arguments: { invoices: [{ invoice: 'spark1-test' }] } }, undefined, { timeout: 60000 });
    await source.close();
    expect(source.listTools()).toEqual([]);
  });
  it('does not reinterpret other servers and blocks direct execution of filtered tools', async () => {
    wire.listTools.mockReset().mockResolvedValue({ tools: [def('spark_pay_invoice', { invoice: { type: 'string' } }), def('sign')] });
    const source = new McpToolSource({ id: 'test', allow: ['spark_pay_invoice'], transport: { kind: 'stdio', command: 'unused' } });
    await source.connect();
    await expect(source.execute('sign', {})).rejects.toThrow('not exposed');
    await source.execute('spark_pay_invoice', { invoice: 'lnbc-test' });
    expect(wire.callTool).toHaveBeenLastCalledWith({ name: 'spark_pay_invoice', arguments: { invoice: 'lnbc-test' } }, undefined, { timeout: 60000 });
  });
});
