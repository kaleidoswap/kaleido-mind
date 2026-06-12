import { describe, expect, it } from 'vitest';
import {
  LSPS1_TOOLS,
  LSPS1_SPEND_TOOLS,
  isLsps1SpendTool,
  getLsps1Tool,
  bindLsps1Tools,
  type Lsps1Handler,
} from './contract.js';

describe('LSPS1_TOOLS — shape invariants', () => {
  it('exposes the expected tool names', () => {
    expect(LSPS1_TOOLS.map((t) => t.name)).toEqual([
      'lsp_get_info',
      'lsp_get_network_info',
      'lsp_estimate_fees',
      'lsp_create_order',
      'lsp_get_order',
    ]);
  });

  it('every tool has an object parameters schema', () => {
    for (const t of LSPS1_TOOLS) {
      expect((t.parameters as any)?.type).toBe('object');
    }
  });

  it('aligns spend ↔ requiresConfirmation', () => {
    for (const t of LSPS1_TOOLS) {
      expect(!!t.spend).toBe(!!t.requiresConfirmation);
    }
  });

  it('marks only lsp_create_order as spend', () => {
    expect([...LSPS1_SPEND_TOOLS]).toEqual(['lsp_create_order']);
    expect(isLsps1SpendTool('lsp_create_order')).toBe(true);
    expect(isLsps1SpendTool('lsp_get_info')).toBe(false);
  });

  it('getLsps1Tool returns by name', () => {
    expect(getLsps1Tool('lsp_estimate_fees')?.name).toBe('lsp_estimate_fees');
    expect(getLsps1Tool('nope')).toBeUndefined();
  });
});

describe('bindLsps1Tools', () => {
  const echoHandlers = (): Record<string, Lsps1Handler> => ({
    lsp_get_info:         async () => ({ ok: true, t: 'get_info' }),
    lsp_get_network_info: async () => ({ ok: true, t: 'get_network_info' }),
    lsp_estimate_fees:    async (a) => ({ ok: true, t: 'estimate_fees', args: a }),
    lsp_create_order:     async (a) => ({ ok: true, t: 'create_order', args: a }),
    lsp_get_order:        async (a) => ({ ok: true, t: 'get_order', args: a }),
  });

  it('binds every tool and preserves the spend gate', () => {
    const src = bindLsps1Tools(echoHandlers());
    expect(src.listTools().length).toBe(5);
    const create = src.listTools().find((t) => t.name === 'lsp_create_order');
    expect(create?.requiresConfirmation).toBe(true);
    const info = src.listTools().find((t) => t.name === 'lsp_get_info');
    expect(info?.requiresConfirmation).toBeFalsy();
  });

  it('dispatches with args', async () => {
    const src = bindLsps1Tools(echoHandlers());
    const r = await src.execute('lsp_estimate_fees', { lsp_balance_sat: 500_000 });
    expect(r).toMatchObject({ ok: true, t: 'estimate_fees', args: { lsp_balance_sat: 500_000 } });
  });

  it('throws on a missing handler unless allowMissing', () => {
    const partial = { lsp_get_info: echoHandlers().lsp_get_info };
    expect(() => bindLsps1Tools(partial)).toThrow(/no handler/);
    const src = bindLsps1Tools(partial, { allowMissing: true });
    expect(src.listTools().map((t) => t.name)).toEqual(['lsp_get_info']);
  });

  it('uses opts.id for the ToolSource id', () => {
    const src = bindLsps1Tools(echoHandlers(), { id: 'lsp-prod' });
    expect(src.id).toBe('lsp-prod');
  });
});
