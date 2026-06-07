import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../tools/registry.js';
import { InProcessToolSource } from '../tools/in-process.js';
import type { LLMProvider } from '../providers/types.js';
import { runRecipe, RecipeRegistry } from './runner.js';
import { paymentsRecipe, extractPayment } from './payments.js';
import { swapRecipe, extractSwap } from './swap.js';

// Stub contract tools: resolve_contact, fiat_to_sats, send_payment (spend).
function stubTools(spy?: { send?: (a: any) => void }) {
  const src = new InProcessToolSource('wallet', [
    { name: 'resolve_contact', description: '', parameters: { type: 'object', properties: {} }, handler: async ({ name }) => ({ name, ln_address: `${name}@kaleidoswap.com` }) },
    { name: 'fiat_to_sats', description: '', parameters: { type: 'object', properties: {} }, handler: async ({ amount }) => ({ sats: Math.round(Number(amount) * 1000) }) },
    { name: 'send_payment', description: '', parameters: { type: 'object', properties: {} }, requiresConfirmation: true, handler: async (a) => { spy?.send?.(a); return { status: 'SUCCESS', payment_hash: 'h' }; } },
  ]);
  return new ToolRegistry([src]);
}

const approve: LLMProvider = { name: 'x', runTurn: async () => ({ text: '', rawContent: '', toolCalls: [] }) };

describe('extractPayment (deterministic Tier-0)', () => {
  it('parses contact + fiat', () => {
    expect(extractPayment('pay bob 3 eur')).toEqual({ recipient: 'bob', amount: 3, currency: 'eur' });
  });
  it('parses "send N sats to X"', () => {
    expect(extractPayment('send 5,000 sats to alice')).toEqual({ recipient: 'alice', amount: 5000, currency: 'sats' });
  });
  it('parses btc + onchain-ish recipient', () => {
    expect(extractPayment('send 0.001 btc to bob')).toEqual({ recipient: 'bob', amount: 0.001, currency: 'btc' });
  });
  it('expands k/m shorthand (no 1000x under-send)', () => {
    expect(extractPayment('send 5k sats to bob')).toEqual({ recipient: 'bob', amount: 5000, currency: 'sats' });
    expect(extractPayment('send 2m sats to alice')).toEqual({ recipient: 'alice', amount: 2_000_000, currency: 'sats' });
  });
  it('returns null for non-payment text', () => {
    expect(extractPayment('what is my balance')).toBeNull();
  });
});

describe('runRecipe — pay a contact', () => {
  it('fiat path: resolve → fiat_to_sats → confirm → send', async () => {
    const sent: any[] = [];
    const tools = stubTools({ send: (a) => sent.push(a) });
    const onConfirm = vi.fn(async () => ({ approved: true }));
    const res = await runRecipe(paymentsRecipe, 'pay bob 3 eur', { provider: approve, tools, onConfirm });

    expect(res.status).toBe('done');
    expect(res.inferences).toBe(0); // deterministic extraction, no LLM
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(res.results.contact).toMatchObject({ ln_address: 'bob@kaleidoswap.com' });
    expect(sent[0]).toEqual({ to: 'bob@kaleidoswap.com', amount_sats: 3000 }); // 3 * 1000
    expect(res.text).toContain('3,000 sats');
  });

  it('sats path skips fiat_to_sats', async () => {
    const sent: any[] = [];
    const tools = stubTools({ send: (a) => sent.push(a) });
    const res = await runRecipe(paymentsRecipe, 'send 5000 sats to alice', { provider: approve, tools, onConfirm: async () => ({ approved: true }) });
    expect(res.status).toBe('done');
    expect(res.results.conv).toBeUndefined(); // fiat step skipped
    expect(sent[0]).toEqual({ to: 'alice@kaleidoswap.com', amount_sats: 5000 });
  });

  it('denied confirmation → cancelled, nothing sent', async () => {
    const sent: any[] = [];
    const tools = stubTools({ send: (a) => sent.push(a) });
    const res = await runRecipe(paymentsRecipe, 'pay bob 3 eur', { provider: approve, tools, onConfirm: async () => ({ approved: false }) });
    expect(res.status).toBe('cancelled');
    expect(sent).toHaveLength(0);
  });

  it('falls back to ONE LLM extraction when regex misses', async () => {
    const sent: any[] = [];
    const tools = stubTools({ send: (a) => sent.push(a) });
    // A recipe with no deterministic extractor → must use the provider.
    const llmOnly = { ...paymentsRecipe, extract: undefined };
    const provider: LLMProvider = {
      name: 'mock',
      runTurn: vi.fn(async () => ({ text: '', rawContent: '', toolCalls: [{ id: '1', name: 'extract_request', arguments: { recipient: 'bob', amount: 2, currency: 'usd' } }] })),
    };
    const res = await runRecipe(llmOnly, 'could you move a couple bucks to bob', { provider, tools, onConfirm: async () => ({ approved: true }) });
    expect(res.inferences).toBe(1);
    expect(provider.runTurn).toHaveBeenCalledOnce();
    expect(sent[0]).toEqual({ to: 'bob@kaleidoswap.com', amount_sats: 2000 });
  });
});

describe('extractSwap', () => {
  it('parses "buy X <to> with <from>"', () => {
    expect(extractSwap('buy 0.001 btc with usdt')).toEqual({ amount: 0.001, to_asset: 'BTC', from_asset: 'USDT' });
  });
  it('parses "swap X <from> for <to>"', () => {
    expect(extractSwap('swap 10 usdt for btc')).toEqual({ amount: 10, from_asset: 'USDT', to_asset: 'BTC' });
  });
  it('returns null for non-swap text', () => {
    expect(extractSwap('what is my balance')).toBeNull();
  });
});

describe('runRecipe — swap', () => {
  it('quote → confirm → execute', async () => {
    const exec: any[] = [];
    const tools = new ToolRegistry([new InProcessToolSource('w', [
      { name: 'get_swap_quote', description: '', parameters: { type: 'object', properties: {} }, handler: async (a) => ({ quote_id: 'q1', receive_amount: 1500, ...a }) },
      { name: 'execute_swap', description: '', parameters: { type: 'object', properties: {} }, requiresConfirmation: true, handler: async (a) => { exec.push(a); return { status: 'SUCCESS' }; } },
    ])]);
    const onConfirm = vi.fn(async () => ({ approved: true }));
    const res = await runRecipe(swapRecipe, 'buy 0.001 btc with usdt', { provider: approve, tools, onConfirm });
    expect(res.status).toBe('done');
    expect(res.inferences).toBe(0);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(res.results.quote).toMatchObject({ quote_id: 'q1' });
    expect(exec[0]).toMatchObject({ quote_id: 'q1', from_asset: 'USDT', to_asset: 'BTC', amount: 0.001 });
  });
});

describe('RecipeRegistry', () => {
  it('selects by trigger', () => {
    const reg = new RecipeRegistry([paymentsRecipe]);
    expect(reg.select('pay bob 3 eur')?.name).toBe('pay-contact');
    expect(reg.select('what is my balance')).toBeNull();
  });
});
