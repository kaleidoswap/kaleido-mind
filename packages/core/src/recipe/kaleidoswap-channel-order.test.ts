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
      // Stateful: first call (before snapshot) shows an existing channel;
      // second call (after) shows the existing one PLUS the new one, so the
      // diff identifies 'newch' as freshly opened.
      {
        name: 'rln_list_channels',
        description: '',
        parameters: { type: 'object', properties: {} },
        handler: (() => {
          let calls = 0;
          return async (a: any) => {
            captured.push({ name: 'rln_list_channels', args: a });
            calls += 1;
            const existing = { channel_id: 'oldch', capacity_sat: 2_000_000, inbound_sat: 1_800_000, ready: true, status: 'Opened' };
            if (calls === 1) return { channels: [existing], count: 1 };
            return {
              channels: [
                existing,
                { channel_id: 'newch', capacity_sat: 500_000, inbound_sat: 495_000, outbound_sat: 0, ready: false, status: 'opening' },
              ],
              count: 2,
            };
          };
        })(),
      },
    ]),
  ]);
}

describe('extractChannelOrder — deterministic prefilter', () => {
  it('catches single-amount "buy a 500k inbound channel"', () => {
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

  it('catches dual-amount with side keywords: "20000 on my side 80000 on lsp"', () => {
    const r = extractChannelOrder('buy a channel for me 20000 on my side 80000 on lsp');
    expect(r).toMatchObject({ client_balance_sat: 20_000, lsp_balance_sat: 80_000 });
  });

  it('catches "client_balance 5000 lsp_balance 100000"', () => {
    const r = extractChannelOrder('open channel client_balance 5000 lsp_balance 100000');
    expect(r).toMatchObject({ client_balance_sat: 5_000, lsp_balance_sat: 100_000 });
  });

  it('catches "with 10k push" + "500k inbound"', () => {
    const r = extractChannelOrder('buy a channel with 10k push and 500k inbound');
    expect(r).toMatchObject({ client_balance_sat: 10_000, lsp_balance_sat: 500_000 });
  });

  it('catches "Nk sats my side, Mk sats lsp side" (unit between number and side)', () => {
    const r = extractChannelOrder('buy a channel: 100k sats my side, 5M sats lsp side');
    expect(r).toMatchObject({ client_balance_sat: 100_000, lsp_balance_sat: 5_000_000 });
  });

  it('catches an asset channel: ticker + asset amount', () => {
    const r = extractChannelOrder('buy a USDT channel: 5M sats lsp side, 100 USDT inbound');
    expect(r).toMatchObject({
      lsp_balance_sat: 5_000_000,
      asset_ticker: 'USDT',
      lsp_asset_amount: 100,
    });
  });

  it('catches dual-side asset: 100 USDT inbound + 20 USDT pushed to my side', () => {
    const r = extractChannelOrder(
      'buy a USDT channel: 5M sats lsp side, 100k sats my side, 100 USDT inbound, 20 USDT pushed to my side',
    );
    expect(r).toMatchObject({
      lsp_balance_sat: 5_000_000,
      client_balance_sat: 100_000,
      asset_ticker: 'USDT',
      lsp_asset_amount: 100,
      client_asset_amount: 20,
    });
  });

  it('returns null when no concrete fields extractable (intent-only)', () => {
    // The Funnel still fires the recipe via forceModelExtract + match(),
    // so the LLM does the actual extraction. The extractor only contributes
    // when it can pull a real value out.
    expect(extractChannelOrder('I want a channel order')).toBeNull();
    expect(extractChannelOrder('buy channel from kaleid')).toBeNull();
  });

  it('returns null on ambiguous dual-number phrasing (no side keywords)', () => {
    // "buy channel 20000 80000" — could be either. Let the LLM decide via the
    // recipe's forceModelExtract path.
    expect(extractChannelOrder('buy channel 20000 80000')).toBeNull();
  });

  it('ignores unrelated text', () => {
    expect(extractChannelOrder('what is my balance')).toBeNull();
    expect(extractChannelOrder('swap 1000 sats to usdt')).toBeNull();
  });

  it('catches "on the other" after "my side" (user-reported variation)', () => {
    const r = extractChannelOrder('get a channel with 30000 on my side and 80000 on the other');
    expect(r).toMatchObject({ client_balance_sat: 30_000, lsp_balance_sat: 80_000 });
  });

  it('catches "with X on my side and Y on the other side"', () => {
    const r = extractChannelOrder('buy a channel with 20000 on my side and 100000 on the other side');
    expect(r).toMatchObject({ client_balance_sat: 20_000, lsp_balance_sat: 100_000 });
  });

  it('catches "on lsps" variant with "on the other"', () => {
    const r = extractChannelOrder('get a channel for me with 100000 on lsps and 20000 on the other');
    expect(r).toMatchObject({ client_balance_sat: 20_000, lsp_balance_sat: 100_000 });
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

  it('does NOT trigger on explanatory questions about channels', () => {
    const m = kaleidoswapChannelOrderRecipe.match!;
    // These should route to RAG-backed knowledge answering, not the recipe.
    expect(m('why do I need to buy a channel before swapping?')).toBe(false);
    expect(m('how does an inbound channel work?')).toBe(false);
    expect(m('what is inbound liquidity?')).toBe(false);
    expect(m('do I need a channel to receive lightning payments?')).toBe(false);
    expect(m('can I receive without an inbound channel?')).toBe(false);
  });

  it('does NOT trigger on read/verify questions about EXISTING channels', () => {
    const m = kaleidoswapChannelOrderRecipe.match!;
    // A spend must never fire from a question about channels the user has.
    // These route to rgb-lightning-node (rln_list_channels).
    expect(m('list my channels')).toBe(false);
    expect(m('list my channels and their capacities')).toBe(false);
    expect(m('do I have a channel with about 60000 inbound and 15000 on my side?')).toBe(false);
    expect(m('show my channels')).toBe(false);
    expect(m('check my channel status')).toBe(false);
    expect(m('which channels do I have')).toBe(false);
    expect(m('what is the status of my channel order')).toBe(false);
  });

  it('STILL triggers on genuine acquire intents (regression guard)', () => {
    const m = kaleidoswapChannelOrderRecipe.match!;
    expect(m('buy me a channel: 60000 sats inbound and 15000 on my side')).toBe(true);
    expect(m('buy a 500k inbound channel')).toBe(true);
    expect(m('open a channel from the LSP, 200k inbound')).toBe(true);
    expect(m('I need 1M inbound liquidity')).toBe(true);
    expect(m("I can't receive payments")).toBe(true);
    expect(m('order a lsps1 channel')).toBe(true);
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
      'rln_list_channels', // before-snapshot
      'lsp_create_order',
      'rln_pay_invoice',
      'rln_list_channels', // after — verification (read-only final)
    ]);
  });

  it('verification diff identifies the NEW channel (not pre-existing ones)', async () => {
    const captured: { name: string; args: any }[] = [];
    const tools = buildStubs(captured);
    const res = await runRecipe(kaleidoswapChannelOrderRecipe, 'buy a 500000-sat inbound channel', {
      provider: refusingProvider,
      tools,
      onConfirm: async () => ({ approved: true }),
      slots: { lsp_balance_sat: 500_000 },
    });
    // The summary should reference the NEW channel (500k), not the old 2M one.
    expect(res.text).toMatch(/New channel/);
    expect(res.text).toMatch(/500,000-sat/);
    expect(res.text).not.toMatch(/2,000,000/);
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

describe('kaleidoswapChannelOrderRecipe — missing info', () => {
  it('returns status:needs-info (not error) when lsp_balance_sat is missing', async () => {
    // LLM emits no slots → confident() fails → recipe asks the user instead
    // of running the chain with bad data.
    const emptyExtractProvider: LLMProvider = {
      name: 'empty',
      runTurn: async () => ({ text: '', rawContent: '', toolCalls: [] }),
    };
    const captured: { name: string; args: any }[] = [];
    const tools = buildStubs(captured);

    const res = await runRecipe(kaleidoswapChannelOrderRecipe, 'buy a channel from kaleid', {
      provider: emptyExtractProvider,
      tools,
      onConfirm: async () => ({ approved: true }),
    });

    expect(res.status).toBe('needs-info');
    expect(res.text).toMatch(/lsp_balance_sat|specify/i);
    // No tools should have been called.
    expect(captured.length).toBe(0);
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
