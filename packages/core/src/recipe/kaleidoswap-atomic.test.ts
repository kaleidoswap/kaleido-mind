import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../tools/registry.js';
import { InProcessToolSource } from '../tools/in-process.js';
import type { LLMProvider } from '../providers/types.js';
import { runRecipe } from './runner.js';
import { kaleidoswapAtomicRecipe } from './kaleidoswap-atomic.js';

// LLM provider that should never be called when slots are extracted deterministically.
const refusingProvider: LLMProvider = {
  name: 'refusing',
  runTurn: async () => {
    throw new Error('provider should NOT be called when extractSwap succeeds');
  },
};

// Stub tools that record every call so we can assert the chain ran end-to-end.
function buildStubs(captured: { name: string; args: any }[]) {
  const tool = (name: string, response: any, spend = false) => ({
    name,
    description: '',
    parameters: { type: 'object', properties: {} },
    requiresConfirmation: spend,
    handler: async (a: any) => {
      captured.push({ name, args: a });
      return typeof response === 'function' ? response(a) : response;
    },
  });
  return new ToolRegistry([
    new InProcessToolSource('kaleidoswap', [
      tool('kaleidoswap_get_quote', { quote_id: 'q-1', receive_amount: 100, fees: 250 }),
      tool('kaleidoswap_atomic_init', { atomic_id: 'a-1', maker_invoice: 'lnbc1maker' }, /* spend */ true),
      tool('kaleidoswap_atomic_execute', { status: 'completed' }, /* spend */ true),
    ]),
    new InProcessToolSource('rln', [
      tool('rln_create_rgb_invoice', { invoice: 'rgb:invoice:USDT:100' }),
      tool('rln_create_ln_invoice', { invoice: 'lnbc1user' }),
      tool('rln_pay_invoice', { status: 'SUCCESS', payment_hash: 'h' }, /* spend */ true),
    ]),
  ]);
}

describe('kaleidoswapAtomicRecipe — selection (match + triggers)', () => {
  it('triggers on explicit atomic-swap phrasings', () => {
    expect(kaleidoswapAtomicRecipe.match!('atomic swap 100000 sats for usdt')).toBe(true);
    expect(kaleidoswapAtomicRecipe.match!('trustless swap btc to usdt')).toBe(true);
    expect(kaleidoswapAtomicRecipe.match!('htlc swap 1000 sats to USDT')).toBe(true);
  });

  it('does NOT fire on a plain swap (those go to swapRecipe)', () => {
    expect(kaleidoswapAtomicRecipe.match!('swap 10 usdt for btc')).toBe(false);
    expect(kaleidoswapAtomicRecipe.match!('exchange 1000 sats for usdt')).toBe(false);
  });
});

describe('kaleidoswapAtomicRecipe — RGB receive leg', () => {
  it('runs quote → rgb_invoice → atomic_init → pay → atomic_execute (one inference)', async () => {
    const captured: { name: string; args: any }[] = [];
    const tools = buildStubs(captured);

    const res = await runRecipe(kaleidoswapAtomicRecipe, 'atomic swap 100000 sats for usdt', {
      provider: refusingProvider,
      tools,
      onConfirm: async () => ({ approved: true }),
    });

    expect(res.status).toBe('done');
    expect(res.inferences).toBe(0); // extractSwap handled it deterministically

    // The chain: quote → rgb_invoice → atomic_init → pay → atomic_execute (5 calls).
    expect(captured.map((c) => c.name)).toEqual([
      'kaleidoswap_get_quote',
      'rln_create_rgb_invoice',
      'kaleidoswap_atomic_init',
      'rln_pay_invoice',
      'kaleidoswap_atomic_execute',
    ]);

    // RGB invoice fed into atomic_init.
    const init = captured.find((c) => c.name === 'kaleidoswap_atomic_init')!;
    expect(init.args).toEqual({ quote_id: 'q-1', receive_invoice: 'rgb:invoice:USDT:100' });

    // Maker invoice fed into pay step.
    const pay = captured.find((c) => c.name === 'rln_pay_invoice')!;
    expect(pay.args).toEqual({ invoice: 'lnbc1maker' });

    // Final execute carried the atomic id.
    const exe = captured.find((c) => c.name === 'kaleidoswap_atomic_execute')!;
    expect(exe.args).toEqual({ atomic_id: 'a-1' });
  });
});

describe('kaleidoswapAtomicRecipe — BTC receive leg', () => {
  it('uses rln_create_ln_invoice (not rgb) when to_asset is BTC', async () => {
    const captured: { name: string; args: any }[] = [];
    const tools = buildStubs(captured);

    const res = await runRecipe(kaleidoswapAtomicRecipe, 'atomic swap 100 usdt for btc', {
      provider: refusingProvider,
      tools,
      onConfirm: async () => ({ approved: true }),
    });

    expect(res.status).toBe('done');
    expect(captured.map((c) => c.name)).toEqual([
      'kaleidoswap_get_quote',
      'rln_create_ln_invoice',
      'kaleidoswap_atomic_init',
      'rln_pay_invoice',
      'kaleidoswap_atomic_execute',
    ]);
    const init = captured.find((c) => c.name === 'kaleidoswap_atomic_init')!;
    expect(init.args.receive_invoice).toBe('lnbc1user');
  });
});

describe('kaleidoswapAtomicRecipe — confirmation gate', () => {
  it('cancels the chain when the user declines a spend gate', async () => {
    const captured: { name: string; args: any }[] = [];
    const tools = buildStubs(captured);
    let firstSpendSeen = false;

    const res = await runRecipe(kaleidoswapAtomicRecipe, 'atomic swap 100000 sats for usdt', {
      provider: refusingProvider,
      tools,
      onConfirm: async () => {
        if (firstSpendSeen) return { approved: true };
        firstSpendSeen = true;
        return { approved: false, reason: 'user said no' };
      },
    });

    expect(res.status).not.toBe('done');
    // The first spend tool (atomic_init) should NOT have completed successfully —
    // the chain stops before pay/execute.
    expect(captured.some((c) => c.name === 'rln_pay_invoice')).toBe(false);
    expect(captured.some((c) => c.name === 'kaleidoswap_atomic_execute')).toBe(false);
  });
});
