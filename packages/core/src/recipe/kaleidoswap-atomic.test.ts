import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../tools/registry.js';
import { InProcessToolSource } from '../tools/in-process.js';
import type { LLMProvider } from '../providers/types.js';
import { runRecipe } from './runner.js';
import { kaleidoswapAtomicRecipe } from './kaleidoswap-atomic.js';

// LLM provider that should never be called when slots are pre-supplied to runRecipe
// (or when a recipe is not using forceModelExtract).
const refusingProvider: LLMProvider = {
  name: 'refusing',
  runTurn: async () => {
    throw new Error('provider should NOT be called (slots pre-supplied or det path)');
  },
};

/**
 * Stub the maker + node tools. The quote echoes full asset specs (asset_id +
 * maker-unit amount) the way the real maker does, so init can source them.
 */
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
      tool('kaleidoswap_get_quote', {
        rfq_id: 'rfq-1',
        from_asset: { asset_id: 'USDT', ticker: 'USDT', amount: 10_000_000 },
        to_asset: { asset_id: 'BTC', ticker: 'BTC', amount: 15_250_000 },
        from_amount_display: '10 USDT',
        to_amount_display: '15,250 sats',
        fee_display: '154 sats',
      }),
      tool('kaleidoswap_atomic_init', { swapstring: 'SWAP/abc/def', payment_hash: 'ph-1' }, /* spend */ true),
      tool('kaleidoswap_atomic_execute', { status: 200, message: 'Swap executed successfully.' }, /* spend */ true),
    ]),
    new InProcessToolSource('rln', [
      tool('rln_get_node_info', { pubkey: '03c31dae' }),
      tool('rln_whitelist_swap', { ok: true }, /* spend */ true),
    ]),
  ]);
}

describe('kaleidoswapAtomicRecipe — selection', () => {
  it('triggers on swap phrasings', () => {
    expect(kaleidoswapAtomicRecipe.match!('swap 10 usdt to btc')).toBe(true);
    expect(kaleidoswapAtomicRecipe.match!('exchange 100000 sats for usdt')).toBe(true);
    expect(kaleidoswapAtomicRecipe.match!('convert btc to usdt')).toBe(true);
  });
  it('triggers on buy/sell of a crypto asset (the reported bug)', () => {
    expect(kaleidoswapAtomicRecipe.match!('buy one usdt from kaleido')).toBe(true);
    expect(kaleidoswapAtomicRecipe.match!('sell 100 usdt')).toBe(true);
  });
  it('does NOT trigger on buying a gift card (that is commerce, not a swap)', () => {
    expect(kaleidoswapAtomicRecipe.match!('buy a gift card')).toBe(false);
    expect(kaleidoswapAtomicRecipe.match!('buy an amazon voucher')).toBe(false);
  });
  it('does not trigger on a balance question', () => {
    expect(kaleidoswapAtomicRecipe.match!('what is my balance')).toBe(false);
  });
});

describe('kaleidoswapAtomicRecipe — forceModelExtract (less deterministic slot parsing)', () => {
  it('always uses 1 LLM inference for slots even when a det extract would succeed (model does the NL understanding)', async () => {
    const captured: { name: string; args: any }[] = [];
    const tools = buildStubs(captured);

    // Provider that handles the synthetic extract_request tool the runner builds.
    const modelExtractProvider: LLMProvider = {
      name: 'model-extract',
      runTurn: async (input) => {
        // The runner sends a single-turn request with the extract tool.
        const call = input.tools?.find((t) => t.name === 'extract_request');
        if (call && input.messages.some((m) => m.role === 'user' && /usdt/i.test(m.content || ''))) {
          // Simulate the model correctly parsing a natural "buy" phrasing.
          return {
            text: '',
            rawContent: '',
            toolCalls: [{
              id: 'ex1',
              name: 'extract_request',
              arguments: { from_asset: 'BTC', to_asset: 'USDT', amount: 1, amount_side: 'to' },
            }],
          };
        }
        return { text: '', rawContent: '', toolCalls: [] };
      },
    };

    const res = await runRecipe(kaleidoswapAtomicRecipe, 'buy 1 usdt', {
      provider: modelExtractProvider,
      tools,
      onConfirm: async () => ({ approved: true }),
    });

    expect(res.status).toBe('done');
    expect(res.inferences).toBe(1); // forced through the model
    // The execution still used the model-provided slots (from_asset came from the "model" not regex default).
    // (The stub quote in the test is for USDT→BTC, but the point is the inference count + that it ran.)
    expect(captured[0].name).toBe('kaleidoswap_get_quote');
  });
});

describe('kaleidoswapAtomicRecipe — full chain', () => {
  it('runs quote → init → nodeinfo → whitelist → execute in order (one inference)', async () => {
    const captured: { name: string; args: any }[] = [];
    const tools = buildStubs(captured);

    const res = await runRecipe(kaleidoswapAtomicRecipe, 'swap 10 usdt to btc', {
      provider: refusingProvider,
      tools,
      onConfirm: async () => ({ approved: true }),
      // Pre-supply slots so refusingProvider is not hit. This simulates a
      // successful prior extraction (the normal fast path for most recipes,
      // or the early Funnel heuristic for forceModelExtract recipes).
      slots: { from_asset: 'USDT', to_asset: 'BTC', amount: 10, amount_side: 'from' },
    });

    expect(res.status).toBe('done');
    expect(res.inferences).toBe(0);
    expect(captured.map((c) => c.name)).toEqual([
      'kaleidoswap_get_quote',
      'kaleidoswap_atomic_init',
      'rln_get_node_info',
      'rln_whitelist_swap',
      'kaleidoswap_atomic_execute',
    ]);
  });

  it('threads quote → init args (flat asset ids + maker-unit amounts)', async () => {
    const captured: { name: string; args: any }[] = [];
    const tools = buildStubs(captured);
    await runRecipe(kaleidoswapAtomicRecipe, 'swap 10 usdt to btc', {
      provider: refusingProvider, tools, onConfirm: async () => ({ approved: true }),
      slots: { from_asset: 'USDT', to_asset: 'BTC', amount: 10, amount_side: 'from' },
    });
    const init = captured.find((c) => c.name === 'kaleidoswap_atomic_init')!;
    expect(init.args).toEqual({
      rfq_id: 'rfq-1',
      from_asset: 'USDT', from_amount: 10_000_000,
      to_asset: 'BTC', to_amount: 15_250_000,
    });
  });

  it('threads init.swapstring + node.pubkey + init.payment_hash → execute', async () => {
    const captured: { name: string; args: any }[] = [];
    const tools = buildStubs(captured);
    await runRecipe(kaleidoswapAtomicRecipe, 'swap 10 usdt to btc', {
      provider: refusingProvider, tools, onConfirm: async () => ({ approved: true }),
      slots: { from_asset: 'USDT', to_asset: 'BTC', amount: 10, amount_side: 'from' },
    });
    const whitelist = captured.find((c) => c.name === 'rln_whitelist_swap')!;
    expect(whitelist.args).toEqual({ swapstring: 'SWAP/abc/def' });
    const exe = captured.find((c) => c.name === 'kaleidoswap_atomic_execute')!;
    expect(exe.args).toEqual({
      swapstring: 'SWAP/abc/def',
      taker_pubkey: '03c31dae',
      payment_hash: 'ph-1',
    });
  });
});

describe('kaleidoswapAtomicRecipe — single confirmation', () => {
  it('fires ONE gate (before init), showing the quote summary, then runs ungated', async () => {
    const captured: { name: string; args: any }[] = [];
    const tools = buildStubs(captured);
    const confirms: { name: string; summary?: string }[] = [];

    const res = await runRecipe(kaleidoswapAtomicRecipe, 'swap 10 usdt to btc', {
      provider: refusingProvider,
      tools,
      onConfirm: async (call) => {
        confirms.push({ name: call.name, summary: (call as any).summary });
        return { approved: true };
      },
      slots: { from_asset: 'USDT', to_asset: 'BTC', amount: 10, amount_side: 'from' },
    });

    expect(res.status).toBe('done');
    // Exactly one confirm, on the first spend step (init), with the rich summary.
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.name).toBe('kaleidoswap_atomic_init');
    expect(confirms[0]!.summary).toContain('10 USDT');
    expect(confirms[0]!.summary).toContain('15,250 sats');
    expect(confirms[0]!.summary).toContain('154 sats');
  });

  it('declining the single gate cancels the whole chain before any spend', async () => {
    const captured: { name: string; args: any }[] = [];
    const tools = buildStubs(captured);

    const res = await runRecipe(kaleidoswapAtomicRecipe, 'swap 10 usdt to btc', {
      provider: refusingProvider,
      tools,
      onConfirm: async () => ({ approved: false, reason: 'user said no' }),
      slots: { from_asset: 'USDT', to_asset: 'BTC', amount: 10, amount_side: 'from' },
    });

    expect(res.status).toBe('cancelled');
    // Quote ran (read-only), but NOTHING after the declined gate.
    expect(captured.map((c) => c.name)).toEqual(['kaleidoswap_get_quote']);
  });
});
