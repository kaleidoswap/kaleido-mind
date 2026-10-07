/** Wallet contract tests — integrity of the single source of truth. */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSkill } from '../skills/registry.js';
import {
  WALLET_TOOLS,
  SPEND_TOOLS,
  isSpendTool,
  walletTools,
  toToolDefs,
  bindWalletTools,
  getWalletTool,
  normalizeWalletArgs,
} from './contract.js';

describe('WALLET_TOOLS contract', () => {
  it('has unique names and object schemas', () => {
    const names = WALLET_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of WALLET_TOOLS) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]+$/);
      expect((t.parameters as any).type).toBe('object');
    }
  });

  it('namespaces per-layer tools and keeps core helpers unprefixed', () => {
    for (const t of WALLET_TOOLS) {
      if (t.layer === 'core') continue;
      expect(t.name.startsWith(`${t.layer}_`)).toBe(true);
    }
    expect(getWalletTool('send_payment')!.layer).toBe('core');
    expect(getWalletTool('resolve_contact')!.layer).toBe('core');
  });

  it('spend tools are confirmation-gated; reads do not move funds', () => {
    for (const t of WALLET_TOOLS) {
      expect(!!t.requiresConfirmation).toBe(!!t.spend);
    }
    // every fund-moving tool is flagged
    expect(isSpendTool('send_payment')).toBe(true);
    expect(isSpendTool('rln_send_asset')).toBe(true);
    expect(isSpendTool('execute_swap')).toBe(true);
    expect(isSpendTool('spark_send')).toBe(true);
    expect(isSpendTool('spark_pay_invoice')).toBe(true);
    expect(isSpendTool('rln_issue_asset')).toBe(true);
    expect(isSpendTool('rln_create_utxos')).toBe(true);
    // reads are not
    expect(isSpendTool('get_balances')).toBe(false);
    expect(isSpendTool('get_price')).toBe(false);
    expect(isSpendTool('rln_list_assets')).toBe(false);
    expect(isSpendTool('rln_list_transfers')).toBe(false);
    expect([...SPEND_TOOLS].length).toBeGreaterThanOrEqual(5);
  });

  it('spark_pay_invoice is its own tool — BOLT11-shaped, amount optional', () => {
    const def = getWalletTool('spark_pay_invoice');
    expect(def?.layer).toBe('spark');
    expect(def?.spend).toBe(true);
    expect((def!.parameters as any).required).toEqual(['invoice']);
    expect((def!.parameters as any).properties.invoice.type).toBe('string');
    expect((def!.parameters as any).properties.amount_sats.type).toBe('number');
  });

  it('required args declared on the actionable tools', () => {
    expect((getWalletTool('send_payment')!.parameters as any).required).toContain('to');
    expect((getWalletTool('fiat_to_sats')!.parameters as any).required).toEqual(['amount', 'currency']);
    expect((getWalletTool('rln_send_asset')!.parameters as any).required).toEqual(['asset_id', 'recipient_id', 'amount']);
  });
});

describe('normalizeWalletArgs', () => {
  it('fills legacy names for older handlers and canonical names for legacy callers', () => {
    expect(normalizeWalletArgs('rln_send_asset', { asset_id: 'rgb:x', recipient_id: 'utxob:y', amount: 1 }))
      .toEqual({ asset_id: 'rgb:x', asset: 'rgb:x', recipient_id: 'utxob:y', to: 'utxob:y', amount: 1 });
    expect(normalizeWalletArgs('rln_send_asset', { asset: 'USDT', to: 'bob', amount: 2 }))
      .toMatchObject({ asset_id: 'USDT', recipient_id: 'bob' });
    expect(normalizeWalletArgs('get_price', { asset: 'BTC', vs_currency: 'eur' })).toMatchObject({ fiat: 'eur' });
    expect(normalizeWalletArgs('rln_get_balances', { skip_sync: true })).toEqual({ skip_sync: true });
  });

  it('bound handlers receive both shapes', async () => {
    let got: Record<string, unknown> = {};
    const src = bindWalletTools({ rln_create_rgb_invoice: async (a) => { got = a; return {}; } }, { layers: ['rln'], includeCore: false, allowMissing: true });
    await src.execute('rln_create_rgb_invoice', { asset_id: 'USDT', amount: 5 });
    expect(got).toMatchObject({ asset_id: 'USDT', asset: 'USDT', amount: 5 });
  });
});

describe('selectors', () => {
  it('walletTools filters by layer + always includes core unless disabled', () => {
    const spark = walletTools({ layers: ['spark'] });
    expect(spark.some((t) => t.name === 'spark_send')).toBe(true);
    expect(spark.some((t) => t.layer === 'core')).toBe(true); // core included by default
    expect(spark.some((t) => t.layer === 'rln')).toBe(false);

    const noCore = walletTools({ layers: ['spark'], includeCore: false });
    expect(noCore.every((t) => t.layer === 'spark')).toBe(true);
  });

  it('toToolDefs strips metadata but keeps requiresConfirmation', () => {
    const defs = toToolDefs(walletTools({ layers: ['spark'] }));
    const send = defs.find((d) => d.name === 'spark_send')!;
    expect(send.requiresConfirmation).toBe(true);
    expect('layer' in (send as any)).toBe(false);
  });
});

describe('bindWalletTools', () => {
  it('binds handlers → an InProcessToolSource with spend flags preserved', async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const src = bindWalletTools({ spark_get_balance: handler, spark_send: handler }, { layers: ['spark'], includeCore: false, allowMissing: true });
    const tools = src.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['spark_get_balance', 'spark_send']);
    expect(tools.find((t) => t.name === 'spark_send')!.requiresConfirmation).toBe(true);
    expect(await src.execute('spark_get_balance', {})).toEqual({ ok: true });
  });

  it('throws on a missing handler unless allowMissing', () => {
    expect(() => bindWalletTools({}, { layers: ['spark'], includeCore: false })).toThrow(/no handler/);
    const src = bindWalletTools({ spark_get_balance: async () => 1 }, { layers: ['spark'], includeCore: false, allowMissing: true });
    expect(src.listTools().map((t) => t.name)).toEqual(['spark_get_balance']);
  });
});

describe('RLN tools vs kaleido-mcp and the rgb-lightning-node skill', () => {
  // The rln_* tools kaleido-mcp registers (rln_mpp_pay belongs to paid-data).
  const MCP_RLN = [
    'rln_get_node_info', 'rln_get_balances', 'rln_get_asset_balance', 'rln_list_assets',
    'rln_get_address', 'rln_create_rgb_invoice', 'rln_create_ln_invoice', 'rln_pay_invoice',
    'rln_send_btc', 'rln_send_asset', 'rln_list_channels', 'rln_connect_peer', 'rln_open_channel',
    'rln_close_channel', 'rln_get_channel_id', 'rln_list_payments', 'rln_refresh_transfers',
    'rln_atomic_taker', 'rln_list_swaps', 'rln_get_swap',
  ];

  it('covers every rln_* tool kaleido-mcp exposes', () => {
    const missing = MCP_RLN.filter((n) => !getWalletTool(n));
    expect(missing).toEqual([]);
  });

  it('gates every fund-moving or committing RLN tool', () => {
    for (const n of ['rln_send_btc', 'rln_open_channel', 'rln_close_channel', 'rln_atomic_taker']) {
      expect(isSpendTool(n)).toBe(true);
    }
    for (const n of ['rln_get_asset_balance', 'rln_refresh_transfers', 'rln_list_swaps', 'rln_get_swap']) {
      expect(isSpendTool(n)).toBe(false);
    }
  });

  it('the skill only declares tools that exist in the contract', () => {
    const md = readFileSync(new URL('../../skills/rgb-lightning-node/SKILL.md', import.meta.url), 'utf8');
    const skill = parseSkill(md);
    const unknown = (skill.tools ?? []).filter((n) => !getWalletTool(n));
    expect(unknown).toEqual([]);
  });
});
