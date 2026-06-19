import { describe, expect, it } from 'vitest';
import { flashnetSwapRecipe } from './flashnet-swap.js';

describe('flashnetSwapRecipe — selection', () => {
  it('claims swap/buy/sell phrasings with a Flashnet/Spark cue', () => {
    expect(flashnetSwapRecipe.match!('swap 10000 sats with usdb')).toBe(true);
    expect(flashnetSwapRecipe.match!('swap 5000 sats to usdb on flashnet')).toBe(true);
    expect(flashnetSwapRecipe.match!('buy usdb with 1000 sats')).toBe(true);
    expect(flashnetSwapRecipe.match!('exchange btc for usdb on spark')).toBe(true);
    expect(flashnetSwapRecipe.match!('sell 5 usdb')).toBe(true);
  });

  it('does NOT claim RGB swaps (USDT / XAUT belong to kaleidoswap-atomic)', () => {
    expect(flashnetSwapRecipe.match!('swap 100k sats to usdt')).toBe(false);
    expect(flashnetSwapRecipe.match!('convert btc to xaut')).toBe(false);
    expect(flashnetSwapRecipe.match!('sell 10 usdt for sats')).toBe(false);
  });

  it('does NOT claim a bare swap without a Flashnet/Spark cue', () => {
    expect(flashnetSwapRecipe.match!('swap 100000 sats')).toBe(false);
    expect(flashnetSwapRecipe.match!('exchange some bitcoin')).toBe(false);
  });

  it('does NOT claim commerce / receive / channel phrasings', () => {
    expect(flashnetSwapRecipe.match!('buy a gift card with btc')).toBe(false);
    expect(flashnetSwapRecipe.match!('create an invoice for 1000 sats')).toBe(false);
    expect(flashnetSwapRecipe.match!('buy a usdb channel on flashnet')).toBe(false);
  });

  it('does NOT claim educational questions', () => {
    expect(flashnetSwapRecipe.match!('how does a flashnet swap work?')).toBe(false);
    expect(flashnetSwapRecipe.match!('what is usdb?')).toBe(false);
    expect(flashnetSwapRecipe.match!('explain flashnet')).toBe(false);
  });
});

describe('flashnetSwapRecipe — shape', () => {
  it('extracts the 4 swap slots', () => {
    expect(flashnetSwapRecipe.slots.map((s) => s.name).sort()).toEqual([
      'amount', 'amount_side', 'from_asset', 'to_asset',
    ]);
    const required = flashnetSwapRecipe.slots.filter((s) => s.required).map((s) => s.name).sort();
    expect(required).toEqual(['from_asset', 'to_asset']);
  });

  it('forces the model to do slot extraction (not the deterministic regex)', () => {
    expect(flashnetSwapRecipe.forceModelExtract).toBe(true);
  });

  it('runs the canonical 2-step + final chain (list_pools → simulate → execute)', () => {
    expect(flashnetSwapRecipe.steps.map((s) => s.tool)).toEqual([
      'flashnet_list_pools',
      'flashnet_simulate_swap',
    ]);
    expect(flashnetSwapRecipe.final.tool).toBe('flashnet_execute_swap');
  });

  it('confident only when both assets + amount are extracted', () => {
    expect(flashnetSwapRecipe.confident!({})).toBe(false);
    expect(flashnetSwapRecipe.confident!({ from_asset: 'BTC' })).toBe(false);
    expect(flashnetSwapRecipe.confident!({ from_asset: 'BTC', to_asset: 'USDB' })).toBeFalsy();
    expect(flashnetSwapRecipe.confident!({ from_asset: 'BTC', to_asset: 'USDB', amount: 1000 })).toBe(true);
  });

  it('has a recipe-level confirm gate (single approval covers the chain)', () => {
    expect(typeof flashnetSwapRecipe.confirm).toBe('function');
  });
});

describe('flashnetSwapRecipe — direction is LITERAL', () => {
  it('simulate step uses from_asset as asset_in (the spent leg) by construction', () => {
    const simStep = flashnetSwapRecipe.steps.find((s) => s.tool === 'flashnet_simulate_swap')!;
    // Build a minimal ctx as runRecipe would: pools result with a BTC/USDB
    // pool, slots saying from=BTC, to=USDB, amount=10000. The args function
    // must put BTC on asset_in and amount=10000 on amount_in — the previous
    // model-driven inversion bug becomes impossible.
    const ctx: any = {
      slots: { from_asset: 'BTC', to_asset: 'USDB', amount: 10000 },
      results: {
        pools: {
          pools: [{
            pool_id: 'pool-xyz',
            asset_a_address: '0e6354aaaa', asset_a_symbol: 'USDB',
            asset_b_address: '020202bbbb', asset_b_symbol: 'BTC',
          }],
        },
      },
    };
    const args = simStep.args(ctx) as any;
    expect(args.pool_id).toBe('pool-xyz');
    // The pool already stores BTC's address (the SDK constant `020202…`);
    // the recipe passes it through directly so the adapter doesn't have to
    // re-resolve the "BTC" ticker.
    expect(args.asset_in_address).toBe('020202bbbb'); // BTC, from the pool
    expect(args.asset_out_address).toBe('0e6354aaaa'); // USDB by symbol
    expect(args.amount_in).toBe('10000');
  });

  it('execute step computes min_amount_out from the simulated value (not the raw value)', () => {
    const ctx: any = {
      slots: { from_asset: 'BTC', to_asset: 'USDB', amount: 10000 },
      results: {
        pools: { pools: [{ pool_id: 'p', asset_a_address: 'a', asset_a_symbol: 'USDB', asset_b_address: 'b', asset_b_symbol: 'BTC' }] },
        sim:   { amount_out: '1472', execution_price: '0.1472' },
      },
    };
    const args = flashnetSwapRecipe.final.args(ctx) as any;
    // Default 50 bps = 0.5% slippage tolerance → floor(1472 * 0.995) = 1464.
    expect(args.min_amount_out).toBe('1464');
    expect(args.max_slippage_bps).toBe(50);
    // BTC (from_asset) → pool's BTC-side address `b`.
    expect(args.asset_in_address).toBe('b');
  });
});
