import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../tools/registry.js';
import { InProcessToolSource } from '../tools/in-process.js';
import type { LLMProvider } from '../providers/types.js';
import { runRecipe } from './runner.js';
import {
  kaleidoswapChannelOrderRecipe,
  extractChannelOrder,
} from './kaleidoswap-channel-order.js';

const refusingProvider: LLMProvider = {
  name: 'refusing',
  runTurn: async () => {
    throw new Error('provider should NOT be called when slots are pre-supplied');
  },
};

/** Stubs that match the real LSPS1 + RLN response shapes. */
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
    new InProcessToolSource('lsps1', [
      tool('lsp_get_info', {
        lsp_connection_url: '03abc@1.2.3.4:9735',
        options: {
          min_initial_lsp_balance_sat: 50_000,
          max_initial_lsp_balance_sat: 10_000_000,
          max_channel_expiry_blocks: 20160,
        },
        assets: [],
      }),
      tool('lsp_estimate_fees', {
        setup_fee: 100,
        capacity_fee: 250,
        duration_fee: 50,
        total_fee: 400,
      }),
      tool('lsp_create_order', {
        order_id: 'ord-xyz',
        access_token: 'tok-1',
        order_state: 'CREATED',
        payment: {
          bolt11: {
            invoice: 'lnbc500400n1lspsorder',
            order_total_sat: 500_400,
            fee_total_sat: 400,
            state: 'EXPECT_PAYMENT',
          },
        },
      }, /* spend */ true),
      tool('lsp_get_order', { order_state: 'COMPLETED', channel: { channel_id: 'ch-1' } }),
    ]),
    new InProcessToolSource('rln', [
      tool('rln_get_node_info', { pubkey: '03c31dae' }),
      tool('rln_pay_invoice', { status: 'SUCCESS', payment_hash: 'h' }, /* spend */ true),
    ]),
  ]);
}

describe('extractChannelOrder — deterministic prefilter', () => {
  it('catches "buy a 500k inbound channel"', () => {
    const r = extractChannelOrder('buy a 500k inbound channel');
    expect(r).toMatchObject({ lsp_balance_sat: 500_000 });
  });

  it('catches "I need 200000 sats of inbound liquidity"', () => {
    const r = extractChannelOrder('I need 200000 sats of inbound liquidity');
    expect(r).toMatchObject({ lsp_balance_sat: 200_000 });
  });

  it('catches "1M inbound for 30 days"', () => {
    const r = extractChannelOrder('open a channel from the LSP, 1M inbound for 30 days');
    expect(r).toMatchObject({ lsp_balance_sat: 1_000_000, channel_expiry_blocks: 30 * 144 });
  });

  it('catches "channel order" intent even without numbers', () => {
    const r = extractChannelOrder('I want a channel order');
    expect(r).not.toBeNull();
  });

  it('ignores unrelated text', () => {
    expect(extractChannelOrder('what is my balance')).toBeNull();
    expect(extractChannelOrder('swap 1000 sats to usdt')).toBeNull();
  });
});

describe('kaleidoswapChannelOrderRecipe — selection', () => {
  it('triggers on channel-order phrasings', () => {
    const m = kaleidoswapChannelOrderRecipe.match!;
    expect(m('buy a 500k inbound channel')).toBe(true);
    expect(m("I can't receive 1M sats")).toBe(true);
    expect(m('open a channel from the LSP, 200k inbound')).toBe(true);
    expect(m('order a lsps1 channel')).toBe(true);
  });

  it('does NOT trigger on swap / balance / generic Lightning questions', () => {
    const m = kaleidoswapChannelOrderRecipe.match!;
    expect(m('what is my balance')).toBe(false);
    expect(m('swap 1000 sats to usdt')).toBe(false);
    expect(m('what is a Lightning channel?')).toBe(false);
  });
});

describe('kaleidoswapChannelOrderRecipe — full chain', () => {
  it('runs get_info → estimate_fees → get_node_info → create_order → pay_invoice (one inference)', async () => {
    const captured: { name: string; args: any }[] = [];
    const tools = buildStubs(captured);

    const res = await runRecipe(
      kaleidoswapChannelOrderRecipe,
      'buy a 500000-sat inbound channel',
      {
        provider: refusingProvider,
        tools,
        onConfirm: async () => ({ approved: true }),
        slots: { lsp_balance_sat: 500_000 }, // simulate a successful prior extraction
      },
    );

    expect(res.status).toBe('done');
    expect(res.inferences).toBe(0);
    expect(captured.map((c) => c.name)).toEqual([
      'lsp_get_info',
      'lsp_estimate_fees',
      'rln_get_node_info',
      'lsp_create_order',
      'rln_pay_invoice',
    ]);
  });

  it("threads node.pubkey into lsp_create_order's client_pubkey", async () => {
    const captured: { name: string; args: any }[] = [];
    const tools = buildStubs(captured);
    await runRecipe(kaleidoswapChannelOrderRecipe, 'buy a 500000-sat inbound channel', {
      provider: refusingProvider,
      tools,
      onConfirm: async () => ({ approved: true }),
      slots: { lsp_balance_sat: 500_000 },
    });
    const order = captured.find((c) => c.name === 'lsp_create_order')!;
    expect(order.args).toMatchObject({
      client_pubkey: '03c31dae',
      lsp_balance_sat: 500_000,
    });
  });

  it("threads order.payment.bolt11.invoice into rln_pay_invoice", async () => {
    const captured: { name: string; args: any }[] = [];
    const tools = buildStubs(captured);
    await runRecipe(kaleidoswapChannelOrderRecipe, 'buy a 500000-sat inbound channel', {
      provider: refusingProvider,
      tools,
      onConfirm: async () => ({ approved: true }),
      slots: { lsp_balance_sat: 500_000 },
    });
    const pay = captured.find((c) => c.name === 'rln_pay_invoice')!;
    expect(pay.args).toEqual({ invoice: 'lnbc500400n1lspsorder' });
  });
});

describe('kaleidoswapChannelOrderRecipe — single confirmation', () => {
  it('fires ONE gate (before create_order), showing the fee summary', async () => {
    const captured: { name: string; args: any }[] = [];
    const tools = buildStubs(captured);
    const gates: string[] = [];

    const res = await runRecipe(kaleidoswapChannelOrderRecipe, 'buy a 500000-sat inbound channel', {
      provider: refusingProvider,
      tools,
      onConfirm: async (call) => {
        gates.push(call.name);
        return { approved: true };
      },
      slots: { lsp_balance_sat: 500_000 },
    });

    expect(res.status).toBe('done');
    // Exactly one gate fired, at the first spend step (create_order). Pay step
    // ran without a second prompt — the single recipe-confirm covered it.
    expect(gates).toEqual(['lsp_create_order']);
  });

  it('cancels the entire chain on decline (no order, no payment)', async () => {
    const captured: { name: string; args: any }[] = [];
    const tools = buildStubs(captured);

    const res = await runRecipe(kaleidoswapChannelOrderRecipe, 'buy a 500000-sat inbound channel', {
      provider: refusingProvider,
      tools,
      onConfirm: async () => ({ approved: false, reason: 'too expensive' }),
      slots: { lsp_balance_sat: 500_000 },
    });

    expect(res.status).not.toBe('done');
    expect(captured.some((c) => c.name === 'lsp_create_order')).toBe(false);
    expect(captured.some((c) => c.name === 'rln_pay_invoice')).toBe(false);
  });
});
