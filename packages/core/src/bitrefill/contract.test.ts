import { describe, expect, it } from 'vitest';
import {
  BITREFILL_TOOLS,
  BITREFILL_SPEND_TOOLS,
  isBitrefillSpendTool,
  getBitrefillTool,
  bindBitrefillTools,
  type BitrefillHandler,
} from './contract.js';

describe('BITREFILL_TOOLS — shape invariants', () => {
  it('exposes the expected tool names in order', () => {
    expect(BITREFILL_TOOLS.map((t) => t.name)).toEqual([
      'bitrefill_search',
      'bitrefill_get_product',
      'bitrefill_get_balance',
      'bitrefill_create_invoice',
      'bitrefill_get_invoice',
      'bitrefill_get_order',
    ]);
  });

  it('every tool has an object parameters schema', () => {
    for (const t of BITREFILL_TOOLS) {
      expect((t.parameters as any)?.type).toBe('object');
    }
  });

  it('aligns spend ↔ requiresConfirmation', () => {
    for (const t of BITREFILL_TOOLS) {
      expect(!!t.spend).toBe(!!t.requiresConfirmation);
    }
  });

  it('marks only bitrefill_create_invoice as spend', () => {
    expect([...BITREFILL_SPEND_TOOLS]).toEqual(['bitrefill_create_invoice']);
    expect(isBitrefillSpendTool('bitrefill_create_invoice')).toBe(true);
    expect(isBitrefillSpendTool('bitrefill_search')).toBe(false);
    expect(isBitrefillSpendTool('bitrefill_get_balance')).toBe(false);
  });

  it('getBitrefillTool returns by name', () => {
    expect(getBitrefillTool('bitrefill_get_product')?.name).toBe('bitrefill_get_product');
    expect(getBitrefillTool('nope')).toBeUndefined();
  });

  it('create_invoice requires products + payment_method', () => {
    const def = getBitrefillTool('bitrefill_create_invoice')!;
    expect((def.parameters as any).required).toEqual(['products', 'payment_method']);
  });
});

describe('bindBitrefillTools', () => {
  const echoHandlers = (): Record<string, BitrefillHandler> => ({
    bitrefill_search:         async (a) => ({ ok: true, t: 'search', args: a }),
    bitrefill_get_product:    async (a) => ({ ok: true, t: 'get_product', args: a }),
    bitrefill_get_balance:    async () => ({ balance: 100, currency: 'USD' }),
    bitrefill_create_invoice: async (a) => ({ ok: true, t: 'create_invoice', args: a }),
    bitrefill_get_invoice:    async (a) => ({ ok: true, t: 'get_invoice', args: a }),
    bitrefill_get_order:      async (a) => ({ ok: true, t: 'get_order', args: a }),
  });

  it('binds every tool and preserves the spend gate', () => {
    const src = bindBitrefillTools(echoHandlers());
    expect(src.listTools().length).toBe(6);
    const create = src.listTools().find((t) => t.name === 'bitrefill_create_invoice');
    expect(create?.requiresConfirmation).toBe(true);
    const search = src.listTools().find((t) => t.name === 'bitrefill_search');
    expect(search?.requiresConfirmation).toBeFalsy();
  });

  it('dispatches with args', async () => {
    const src = bindBitrefillTools(echoHandlers());
    const r = await src.execute('bitrefill_search', { query: 'amazon', country: 'US' });
    expect(r).toMatchObject({ ok: true, t: 'search', args: { query: 'amazon', country: 'US' } });
  });

  it('throws on a missing handler unless allowMissing', () => {
    const partial = { bitrefill_search: echoHandlers().bitrefill_search };
    expect(() => bindBitrefillTools(partial)).toThrow(/no handler/);
    const src = bindBitrefillTools(partial, { allowMissing: true });
    expect(src.listTools().map((t) => t.name)).toEqual(['bitrefill_search']);
  });

  it('uses opts.id for the ToolSource id', () => {
    const src = bindBitrefillTools(echoHandlers(), { id: 'bitrefill-personal' });
    expect(src.id).toBe('bitrefill-personal');
  });
});
