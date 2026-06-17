/** Wallet contract tests — integrity of the single source of truth. */

import { describe, it, expect, vi } from 'vitest';
import {
  WALLET_TOOLS,
  SPEND_TOOLS,
  isSpendTool,
  walletTools,
  toToolDefs,
  bindWalletTools,
  getWalletTool,
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
    // reads are not
    expect(isSpendTool('get_balances')).toBe(false);
    expect(isSpendTool('get_price')).toBe(false);
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
    expect((getWalletTool('rln_create_rgb_invoice')!.parameters as any).required).toEqual(['asset', 'amount']);
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
