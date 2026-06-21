import { describe, expect, it } from 'vitest';
import {
  FLASHNET_TOOLS,
  FLASHNET_SPEND_TOOLS,
  isFlashnetSpendTool,
  getFlashnetTool,
  bindFlashnetTools,
  type FlashnetHandler,
} from './contract.js';

describe('FLASHNET_TOOLS — shape invariants', () => {
  it('exposes the expected tool names in order', () => {
    expect(FLASHNET_TOOLS.map((t) => t.name)).toEqual([
      'flashnet_list_pools',
      'flashnet_get_pool',
      'flashnet_simulate_swap',
      'flashnet_execute_swap',
      'flashnet_get_balance',
    ]);
  });

  it('every tool has an object parameters schema', () => {
    for (const t of FLASHNET_TOOLS) {
      expect((t.parameters as any)?.type).toBe('object');
    }
  });

  it('aligns spend ↔ requiresConfirmation', () => {
    for (const t of FLASHNET_TOOLS) {
      expect(!!t.spend).toBe(!!t.requiresConfirmation);
    }
  });

  it('marks only flashnet_execute_swap as spend', () => {
    expect([...FLASHNET_SPEND_TOOLS]).toEqual(['flashnet_execute_swap']);
    expect(isFlashnetSpendTool('flashnet_execute_swap')).toBe(true);
    expect(isFlashnetSpendTool('flashnet_simulate_swap')).toBe(false);
    expect(isFlashnetSpendTool('flashnet_list_pools')).toBe(false);
  });

  it('getFlashnetTool returns by name', () => {
    expect(getFlashnetTool('flashnet_simulate_swap')?.name).toBe('flashnet_simulate_swap');
    expect(getFlashnetTool('nope')).toBeUndefined();
  });

  it('execute_swap requires the canonical 5 fields', () => {
    const def = getFlashnetTool('flashnet_execute_swap')!;
    expect((def.parameters as any).required).toEqual([
      'pool_id', 'asset_in_address', 'asset_out_address', 'amount_in', 'min_amount_out',
    ]);
  });

  it('simulate_swap requires pool + assets + amount but no slippage', () => {
    const def = getFlashnetTool('flashnet_simulate_swap')!;
    expect((def.parameters as any).required).toEqual([
      'pool_id', 'asset_in_address', 'asset_out_address', 'amount_in',
    ]);
  });
});

describe('bindFlashnetTools', () => {
  const echoHandlers = (): Record<string, FlashnetHandler> => ({
    flashnet_list_pools:    async (a) => ({ ok: true, t: 'list_pools', args: a }),
    flashnet_get_pool:      async (a) => ({ ok: true, t: 'get_pool', args: a }),
    flashnet_simulate_swap: async (a) => ({ ok: true, t: 'simulate_swap', args: a }),
    flashnet_execute_swap:  async (a) => ({ ok: true, t: 'execute_swap', args: a }),
    flashnet_get_balance:   async () => ({ btc_sats: 100000, tokens: [] }),
  });

  it('binds every tool and preserves the spend gate', () => {
    const src = bindFlashnetTools(echoHandlers());
    expect(src.listTools().length).toBe(5);
    const exec = src.listTools().find((t) => t.name === 'flashnet_execute_swap');
    expect(exec?.requiresConfirmation).toBe(true);
    const sim = src.listTools().find((t) => t.name === 'flashnet_simulate_swap');
    expect(sim?.requiresConfirmation).toBeFalsy();
  });

  it('dispatches with args', async () => {
    const src = bindFlashnetTools(echoHandlers());
    const r = await src.execute('flashnet_simulate_swap', {
      pool_id: 'p1',
      asset_in_address: 'btc',
      asset_out_address: 'usdb',
      amount_in: '100000',
    });
    expect(r).toMatchObject({ ok: true, t: 'simulate_swap' });
  });

  it('throws on a missing handler unless allowMissing', () => {
    const partial = { flashnet_list_pools: echoHandlers().flashnet_list_pools };
    expect(() => bindFlashnetTools(partial)).toThrow(/no handler/);
    const src = bindFlashnetTools(partial, { allowMissing: true });
    expect(src.listTools().map((t) => t.name)).toEqual(['flashnet_list_pools']);
  });

  it('uses opts.id for the ToolSource id', () => {
    const src = bindFlashnetTools(echoHandlers(), { id: 'flashnet-regtest' });
    expect(src.id).toBe('flashnet-regtest');
  });
});
