import { describe, expect, it } from 'vitest';
import {
  KALEIDOSWAP_TOOLS,
  KALEIDOSWAP_SPEND_TOOLS,
  isKaleidoswapSpendTool,
  getKaleidoswapTool,
  kaleidoswapTools,
  bindKaleidoswapTools,
  type KaleidoswapHandler,
} from './contract.js';

describe('KALEIDOSWAP_TOOLS — shape invariants', () => {
  it('exposes the expected tool names', () => {
    const names = KALEIDOSWAP_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      'kaleidoswap_get_assets',
      'kaleidoswap_get_pairs',
      'kaleidoswap_get_quote',
      'kaleidoswap_get_nodeinfo',
      'kaleidoswap_place_order',
      'kaleidoswap_get_order_status',
      'kaleidoswap_get_order_history',
      'kaleidoswap_atomic_init',
      'kaleidoswap_atomic_execute',
      'kaleidoswap_atomic_status',
      'kaleidoswap_lsp_quote_asset_channel',
      'kaleidoswap_lsp_create_asset_channel',
    ]);
  });

  it('every tool has a group and a parameters object', () => {
    for (const t of KALEIDOSWAP_TOOLS) {
      expect(['market', 'orders', 'atomic', 'liquidity']).toContain(t.group);
      expect(t.parameters).toBeDefined();
      expect((t.parameters as any).type).toBe('object');
    }
  });

  it('marks every spend tool as requiresConfirmation', () => {
    for (const t of KALEIDOSWAP_TOOLS) {
      expect(!!t.spend).toBe(!!t.requiresConfirmation);
    }
  });

  it('lists every spend tool exactly once in KALEIDOSWAP_SPEND_TOOLS', () => {
    const expected = KALEIDOSWAP_TOOLS.filter((t) => t.spend).map((t) => t.name).sort();
    expect([...KALEIDOSWAP_SPEND_TOOLS].sort()).toEqual(expected);
    // Sanity: place_order, atomic_init/execute, create_asset_channel are spend; the rest aren't.
    expect(expected).toEqual([
      'kaleidoswap_atomic_execute',
      'kaleidoswap_atomic_init',
      'kaleidoswap_lsp_create_asset_channel',
      'kaleidoswap_place_order',
    ]);
  });

  it('isKaleidoswapSpendTool agrees with the set', () => {
    expect(isKaleidoswapSpendTool('kaleidoswap_place_order')).toBe(true);
    expect(isKaleidoswapSpendTool('kaleidoswap_get_pairs')).toBe(false);
    expect(isKaleidoswapSpendTool('not_a_tool')).toBe(false);
  });

  it('getKaleidoswapTool returns by name', () => {
    expect(getKaleidoswapTool('kaleidoswap_get_quote')?.group).toBe('market');
    expect(getKaleidoswapTool('nope')).toBeUndefined();
  });
});

describe('kaleidoswapTools(groups)', () => {
  it('returns all tools when no group filter', () => {
    expect(kaleidoswapTools().length).toBe(KALEIDOSWAP_TOOLS.length);
  });

  it('filters by group', () => {
    const market = kaleidoswapTools({ groups: ['market'] });
    expect(market.every((t) => t.group === 'market')).toBe(true);
    expect(market.map((t) => t.name)).toContain('kaleidoswap_get_quote');
    expect(market.map((t) => t.name)).not.toContain('kaleidoswap_place_order');
  });

  it('combines multiple groups', () => {
    const readPlusOrders = kaleidoswapTools({ groups: ['market', 'orders'] });
    expect(readPlusOrders.some((t) => t.name === 'kaleidoswap_atomic_init')).toBe(false);
    expect(readPlusOrders.some((t) => t.name === 'kaleidoswap_place_order')).toBe(true);
  });
});

describe('bindKaleidoswapTools', () => {
  // Handlers that just echo their args so we can verify wiring.
  const echoHandlers = (): Record<string, KaleidoswapHandler> => ({
    kaleidoswap_get_assets:        async () => ({ ok: true, tool: 'get_assets' }),
    kaleidoswap_get_pairs:         async () => ({ ok: true, tool: 'get_pairs' }),
    kaleidoswap_get_quote:         async (a) => ({ ok: true, tool: 'get_quote', args: a }),
    kaleidoswap_get_nodeinfo:      async () => ({ ok: true, tool: 'get_nodeinfo' }),
    kaleidoswap_place_order:       async (a) => ({ ok: true, tool: 'place_order', args: a }),
    kaleidoswap_get_order_status:  async (a) => ({ ok: true, tool: 'get_order_status', args: a }),
    kaleidoswap_get_order_history: async (a) => ({ ok: true, tool: 'get_order_history', args: a }),
    kaleidoswap_atomic_init:       async (a) => ({ ok: true, tool: 'atomic_init', args: a }),
    kaleidoswap_atomic_execute:    async (a) => ({ ok: true, tool: 'atomic_execute', args: a }),
    kaleidoswap_atomic_status:     async (a) => ({ ok: true, tool: 'atomic_status', args: a }),
    kaleidoswap_lsp_quote_asset_channel:  async (a) => ({ ok: true, tool: 'lsp_quote_asset_channel', args: a }),
    kaleidoswap_lsp_create_asset_channel: async (a) => ({ ok: true, tool: 'lsp_create_asset_channel', args: a }),
  });

  it('binds every tool when all handlers are present', () => {
    const src = bindKaleidoswapTools(echoHandlers());
    const tools = src.listTools();
    expect(tools.length).toBe(KALEIDOSWAP_TOOLS.length);
  });

  it('preserves descriptions and the spend gate (requiresConfirmation)', () => {
    const src = bindKaleidoswapTools(echoHandlers());
    const place = src.listTools().find((t) => t.name === 'kaleidoswap_place_order');
    const pairs = src.listTools().find((t) => t.name === 'kaleidoswap_get_pairs');
    expect(place?.requiresConfirmation).toBe(true);
    expect(pairs?.requiresConfirmation).toBeFalsy();
  });

  it('dispatches execute() to the right handler with args', async () => {
    const src = bindKaleidoswapTools(echoHandlers());
    const r = await src.execute('kaleidoswap_get_quote', { from_asset: 'BTC', to_asset: 'USDT', amount: 100_000 });
    expect(r).toMatchObject({ ok: true, tool: 'get_quote', args: { from_asset: 'BTC', amount: 100_000 } });
  });

  it('throws when a handler is missing and allowMissing is false', () => {
    const handlers = { kaleidoswap_get_pairs: echoHandlers().kaleidoswap_get_pairs };
    expect(() => bindKaleidoswapTools(handlers)).toThrow(/no handler/);
  });

  it('skips missing handlers when allowMissing is true', () => {
    const handlers: Record<string, KaleidoswapHandler> = {
      kaleidoswap_get_pairs: async () => ({ ok: true }),
      kaleidoswap_get_quote: async () => ({ ok: true }),
    };
    const src = bindKaleidoswapTools(handlers, { allowMissing: true });
    const names = src.listTools().map((t) => t.name);
    expect(names).toEqual(['kaleidoswap_get_pairs', 'kaleidoswap_get_quote']);
  });

  it('respects the groups filter when binding', () => {
    const src = bindKaleidoswapTools(echoHandlers(), { groups: ['market'] });
    const names = src.listTools().map((t) => t.name);
    expect(names).toContain('kaleidoswap_get_quote');
    expect(names).not.toContain('kaleidoswap_place_order');
    expect(names).not.toContain('kaleidoswap_atomic_init');
  });

  it('uses opts.id for the ToolSource id', () => {
    const src = bindKaleidoswapTools(echoHandlers(), { id: 'maker-prod' });
    expect(src.id).toBe('maker-prod');
  });
});
