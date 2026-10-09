/** Offline cross-package gate: starts the actual MCP, discovers tools, never spends. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpToolSource } from './mcp.js';

const entry = process.env.KALEIDO_MCP_CONTRACT_PATH;
describe.skipIf(!entry)('published Kaleido MCP contract', () => {
  let source: McpToolSource;
  beforeAll(async () => {
    source = new McpToolSource({ id: 'contract', transport: {
      kind: 'stdio', command: process.execPath, args: [entry!],
      env: {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
        KALEIDO_NETWORK: 'signet',
        WDK_SEED: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      },
    } });
    await source.connect();
  }, 30000);
  afterAll(async () => { await source?.close(); });
  it('gates the real wire catalog across wallet domains and aliases', () => {
    expect(source.listTools().map(t => `${t.requiresConfirmation ? 'confirm' : 'read'} ${t.name}`).sort()).toMatchSnapshot();
    const expected = [
      'wdk_pay_invoice', 'rln_pay_invoice', 'wdk_send_btc', 'rln_send_btc',
      'wdk_send_asset', 'rln_send_asset', 'wdk_open_channel', 'rln_open_channel',
      'wdk_close_channel', 'rln_close_channel', 'wdk_atomic_taker', 'rln_atomic_taker',
      'wdk_create_utxos', 'wdk_issue_asset', 'wdk_mpp_pay', 'rln_mpp_pay',
      'spark_pay_lightning_invoice', 'spark_send_sats', 'spark_transfer_token',
      'spark_withdraw', 'spark_pay_invoice', 'spark_pay_spark_invoice', 'spark_mpp_pay',
      'liquid_send_btc', 'liquid_send_asset', 'kaleidoswap_submarine_fund',
      'kaleido_node_down', 'kaleido_node_unlock',
    ];
    for (const name of expected) {
      expect(source.listTools().find(t => t.name === name)?.requiresConfirmation, name).toBe(true);
    }
  });
  it('gives BOLT11 and Spark invoice operations distinct schemas', () => {
    const lightning = source.listTools().find(t => t.name === 'spark_pay_invoice');
    const spark = source.listTools().find(t => t.name === 'spark_pay_spark_invoice');
    expect(lightning?.parameters).toMatchObject({ required: ['invoice'] });
    expect(spark?.parameters).toMatchObject({ required: ['invoices'] });
    expect(source.listTools().find(t => t.name === 'wdk_get_balances')?.requiresConfirmation).toBe(false);
  });
});
