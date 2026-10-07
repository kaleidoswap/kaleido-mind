import { describe, it, expect, vi } from 'vitest';
import { extractSubmarinePay, submarinePayRecipe } from './submarine-pay.js';
import { runRecipe } from './runner.js';
import { Funnel } from '../funnel.js';
import { paymentsRecipe } from './payments.js';
import { MockWallet, scriptedProvider } from '../testing/index.js';
import { SUBMARINE_TOOLS, isSubmarineSpendTool, formatSubmarineAmount } from '../submarine/contract.js';

// 10u = 1,000 sats on signet.
const INVOICE = 'lntbs10u1pnmockinvoice0qqqqqqqqqqqqqqqqqqqqqqqqq';

describe('submarine contract', () => {
  it('only fund moves money, and it takes nothing but the swap id', () => {
    expect(SUBMARINE_TOOLS.map((t) => t.name)).toEqual([
      'kaleidoswap_submarine_pairs', 'kaleidoswap_submarine_create', 'kaleidoswap_submarine_fund', 'kaleidoswap_submarine_status',
    ]);
    expect(SUBMARINE_TOOLS.filter((t) => t.requiresConfirmation).map((t) => t.name)).toEqual(['kaleidoswap_submarine_fund']);
    expect(isSubmarineSpendTool('kaleidoswap_submarine_create')).toBe(false);
    const fund = SUBMARINE_TOOLS.find((t) => t.name === 'kaleidoswap_submarine_fund')!;
    expect(Object.keys((fund.parameters as any).properties)).toEqual(['swap_id']);
  });
  it('formats source amounts for the readback', () => {
    expect(formatSubmarineAmount('L-USDT', '87500000')).toBe('0.875 L-USDT');
    expect(formatSubmarineAmount('L-BTC', 1005)).toBe('1,005 sats of L-BTC');
  });
});

describe('extractSubmarinePay', () => {
  it('needs an invoice and an explicit Liquid asset', () => {
    expect(extractSubmarinePay(`pay ${INVOICE} with L-USDT`)).toEqual({ invoice: INVOICE, from_asset: 'L-USDT' });
    expect(extractSubmarinePay(`paga ${INVOICE} con USDT su Liquid`)).toEqual({ invoice: INVOICE, from_asset: 'L-USDT' });
    expect(extractSubmarinePay(`pay ${INVOICE} using liquid bitcoin`)).toEqual({ invoice: INVOICE, from_asset: 'L-BTC' });
    // Bare USDT is RGB USDT — not this recipe.
    expect(extractSubmarinePay(`pay ${INVOICE} with USDT`)).toBeNull();
    expect(extractSubmarinePay('pay bob 10 L-USDT')).toBeNull();
  });
});

describe('runRecipe — submarine pay against the mock /v2 maker', () => {
  it('creates, confirms once with the maker amount, then funds', async () => {
    const wallet = new MockWallet({ priceUsd: 80_000 });
    const onConfirm = vi.fn(async () => ({ approved: true }));
    const res = await runRecipe(submarinePayRecipe, `pay ${INVOICE} with L-USDT`, { provider: scriptedProvider(), tools: wallet.registry(), onConfirm });
    expect(res.status).toBe('done');
    expect(res.inferences).toBe(0);
    expect(onConfirm).toHaveBeenCalledOnce();
    // 1,000 sats + 0.5% at $80k = 0.804 USD → 80,400,000 units of L-USDT (8 dp).
    expect((onConfirm.mock.calls[0] as any[])[0].summary).toBe(
      'Pay Lightning invoice lntbs10u1p…qqqqqq with 0.804 L-USDT (fees included) through a KaleidoSwap submarine swap. Confirm?');
    expect(wallet.liquid['L-USDT']).toBe(100 * 1e8 - 80_400_000);
    expect(wallet.sends.map((s) => s.tool)).toEqual(['kaleidoswap_submarine_fund']);
    expect(res.text).toMatch(/^Locked 0\.804 L-USDT in swap sub1/);
  });

  it('declining funds nothing, but the swap was opened (no money moved)', async () => {
    const wallet = new MockWallet();
    const res = await runRecipe(submarinePayRecipe, `pay ${INVOICE} with L-USDT`, {
      provider: scriptedProvider(), tools: wallet.registry(), onConfirm: async () => ({ approved: false }),
    });
    expect(res.status).toBe('cancelled');
    expect(wallet.sends).toEqual([]);
    expect(wallet.submarineSwaps.sub1?.funded).toBe(false);
  });

  it('surfaces insufficient Liquid balance without locking anything', async () => {
    const wallet = new MockWallet({ liquid: { 'L-USDT': 1000, 'L-BTC': 0 } });
    const res = await runRecipe(submarinePayRecipe, `pay ${INVOICE} with L-USDT`, {
      provider: scriptedProvider(), tools: wallet.registry(), onConfirm: async () => ({ approved: true }),
    });
    expect(res.status).toBe('error');
    expect(res.error ?? res.text).toMatch(/Insufficient L-USDT/);
    expect(wallet.sends).toEqual([]);
  });
});

describe('Funnel — submarine-pay ahead of payments', () => {
  it('routes "pay <invoice> with L-USDT" to the submarine recipe, plain invoices elsewhere', async () => {
    const wallet = new MockWallet();
    const funnel = new Funnel({ provider: scriptedProvider(), tools: wallet.registry(), recipes: [submarinePayRecipe, paymentsRecipe] });
    const out = await funnel.runTurn(`pay ${INVOICE} with L-USDT`, { onConfirm: async () => ({ approved: true }) });
    expect(out.tier).toBe('recipe');
    expect(out.route).toBe('submarine-pay');
    const status = await wallet.registry().execute('kaleidoswap_submarine_status', { swap_id: 'sub1' }) as { status: string };
    expect(status.status).toBe('transaction.claimed');
    expect(submarinePayRecipe.match!(`pay ${INVOICE}`)).toBe(false);
  });
});
