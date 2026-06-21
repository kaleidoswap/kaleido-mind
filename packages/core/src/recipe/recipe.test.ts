import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../tools/registry.js';
import { InProcessToolSource } from '../tools/in-process.js';
import type { LLMProvider } from '../providers/types.js';
import { runRecipe, RecipeRegistry } from './runner.js';
import { paymentsRecipe, extractPayment } from './payments.js';
import { swapRecipe, extractSwap, extractPriceQuery } from './swap.js';
import { receiveRecipe, extractReceive } from './receive.js';
import { assetSendRecipe, extractAssetSend } from './asset-send.js';
import { paymentsRecipe as _pay } from './payments.js';

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

  it('never reports a failed wallet result as sent', async () => {
    const tools = new ToolRegistry([new InProcessToolSource('wallet', [
      { name: 'resolve_contact', description: '', parameters: { type: 'object', properties: {} }, handler: async ({ name }) => ({ name, ln_address: `${name}@kaleidoswap.com` }) },
      { name: 'fiat_to_sats', description: '', parameters: { type: 'object', properties: {} }, handler: async ({ amount }) => ({ sats: Math.round(Number(amount) * 1000) }) },
      { name: 'send_payment', description: '', parameters: { type: 'object', properties: {} }, requiresConfirmation: true, handler: async () => ({ success: false, message: 'insufficient balance' }) },
    ])]);
    const res = await runRecipe(paymentsRecipe, 'pay bob 3 eur', {
      provider: approve,
      tools,
      onConfirm: async () => ({ approved: true }),
    });
    expect(res.status).toBe('error');
    expect(res.text).toContain('insufficient balance');
    expect(res.text).not.toContain('Sent');
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
  it('parses "buy X <to> with <from>" — amount on the TO leg', () => {
    expect(extractSwap('buy 0.001 btc with usdt')).toEqual({ amount: 0.001, to_asset: 'BTC', from_asset: 'USDT', amount_side: 'to' });
  });
  it('parses "swap X <from> for <to>" — amount on the FROM leg', () => {
    expect(extractSwap('swap 10 usdt for btc')).toEqual({ amount: 10, from_asset: 'USDT', to_asset: 'BTC', amount_side: 'from' });
  });
  it('parses "buy one usdt" — word-number, default funding asset, TO leg (the reported bug)', () => {
    expect(extractSwap('buy one usdt from kaleido')).toEqual({ amount: 1, from_asset: 'BTC', to_asset: 'USDT', amount_side: 'to' });
  });
  it('parses "sell 100 usdt" — default target BTC, FROM leg', () => {
    expect(extractSwap('sell 100 usdt')).toEqual({ amount: 100, from_asset: 'USDT', to_asset: 'BTC', amount_side: 'from' });
  });
  it('ignores a non-asset word as the funding asset ("from kaleido" → defaults BTC)', () => {
    const r = extractSwap('buy 5 xaut from kaleido') as any;
    expect(r.to_asset).toBe('XAUT');
    expect(r.from_asset).toBe('BTC');
  });
  it('returns null for non-swap text', () => {
    expect(extractSwap('what is my balance')).toBeNull();
  });

  // Price-flavoured phrasings belong to extractPriceQuery (separate recipe) —
  // extractSwap returns null for them so the atomic recipe doesn't move funds
  // on a question the user only meant as a rate lookup.
  it('does NOT parse price/rate phrasings (those go to kaleidoswapPriceRecipe)', () => {
    expect(extractSwap('what is the price of usdt in sats')).toBeNull();
    expect(extractSwap('btc price')).toBeNull();
    expect(extractSwap('how much sats for 1 usdt')).toBeNull();
    expect(extractSwap('cost of xaut')).toBeNull();
  });
});

describe('extractPriceQuery', () => {
  it('parses the reported transcript case', () => {
    expect(extractPriceQuery('what is the price of usdt in sats')).toEqual({
      amount: 1, from_asset: 'BTC', to_asset: 'USDT', amount_side: 'to',
    });
  });
  it('tolerates a "the" article', () => {
    expect(extractPriceQuery('what is the price of the usdt in sats?')).toEqual({
      amount: 1, from_asset: 'BTC', to_asset: 'USDT', amount_side: 'to',
    });
  });
  it('"btc price" — funding defaults to USDT when pricing BTC', () => {
    expect(extractPriceQuery('btc price')).toEqual({
      amount: 1, from_asset: 'USDT', to_asset: 'BTC', amount_side: 'to',
    });
  });
  it('"how much sats for 1 usdt" — denom inferred from the unit, not order', () => {
    expect(extractPriceQuery('how much sats for 1 usdt')).toEqual({
      amount: 1, from_asset: 'BTC', to_asset: 'USDT', amount_side: 'to',
    });
  });
  it('handles "cost of xaut" and "how much does 1 btc cost"', () => {
    expect((extractPriceQuery('cost of xaut') as any)?.to_asset).toBe('XAUT');
    expect((extractPriceQuery('how much does 1 btc cost') as any)?.to_asset).toBe('BTC');
  });
  it('does NOT fire on a non-asset price question', () => {
    expect(extractPriceQuery('what is the price of gas')).toBeNull();
    expect(extractPriceQuery('how much does it cost')).toBeNull();
  });
  it('does NOT fire on a swap intent (those go to the atomic recipe)', () => {
    expect(extractPriceQuery('swap 10 usdt to btc')).toBeNull();
    expect(extractPriceQuery('buy one usdt')).toBeNull();
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

describe('extractReceive', () => {
  it('parses asset + layer', () => {
    expect(extractReceive('create an invoice for 25 usdt on liquid')).toEqual({ amount: 25, kind: 'asset', currency: 'USDT', layer: 'liquid' });
  });
  it('amountless BTC invoice', () => {
    expect(extractReceive('give me an invoice')).toEqual({ kind: 'sats', currency: 'BTC' });
  });
  it('sats with k shorthand', () => {
    expect(extractReceive('invoice for 5k sats')).toEqual({ amount: 5000, kind: 'sats', currency: 'BTC' });
  });
  it('fiat: "$2.00" → 2 USD (not 2000)', () => {
    expect(extractReceive('create a payment request of $2.00')).toEqual({ amount: 2, kind: 'fiat', currency: 'USD' });
  });
  it('null for non-receive text', () => {
    expect(extractReceive('pay bob 3 eur')).toBeNull();
  });
});

describe('runRecipe — receive', () => {
  const tools = () => new ToolRegistry([new InProcessToolSource('w', [
    { name: 'fiat_to_sats', description: '', parameters: { type: 'object', properties: {} }, handler: async ({ amount }) => ({ sats: Math.round(Number(amount) * 1500) }) },
    { name: 'create_invoice', description: '', parameters: { type: 'object', properties: {} }, handler: async (a) => ({ invoice: `lnbc-${a.asset}-${a.amount ?? 'any'}` }) },
  ])]);
  it('sats → create_invoice (no confirmation)', async () => {
    const onConfirm = vi.fn(async () => ({ approved: true }));
    const res = await runRecipe(receiveRecipe, 'invoice for 5000 sats', { provider: approve, tools: tools(), onConfirm });
    expect(res.status).toBe('done');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(res.text).toContain('lnbc-BTC-5000');
  });
  it('fiat "$2" → fiat_to_sats → invoice (3000 sats), never 2000', async () => {
    const res = await runRecipe(receiveRecipe, 'create a payment request of $2', { provider: approve, tools: tools() });
    expect(res.status).toBe('done');
    expect(res.text).toContain('lnbc-BTC-3000'); // 2 * 1500
    expect(res.text).toContain('USD 2');
  });
});

describe('extractAssetSend + USDT bug fix', () => {
  it('parses "send N USDT to contact"', () => {
    expect(extractAssetSend('send 10 usdt to bob')).toEqual({ recipient: 'bob', asset: 'USDT', amount: 10 });
  });
  it('null for BTC/sats sends (payments owns those)', () => {
    expect(extractAssetSend('send 5000 sats to bob')).toBeNull();
  });
  it('payments recipe NO LONGER matches an asset send (was the bug)', () => {
    expect(_pay.match!('send 10 usdt to bob')).toBe(false);
    expect(_pay.match!('send 5000 sats to bob')).toBe(true);
    expect(assetSendRecipe.match!('send 10 usdt to bob')).toBe(true);
  });
});

describe('runRecipe — asset send', () => {
  it('resolve → rln_send_asset (confirmation-gated), no fiat conversion', async () => {
    const sent: any[] = [];
    const tools = new ToolRegistry([new InProcessToolSource('w', [
      { name: 'resolve_contact', description: '', parameters: { type: 'object', properties: {} }, handler: async ({ name }) => ({ name, ln_address: `${name}@x.com` }) },
      { name: 'rln_send_asset', description: '', parameters: { type: 'object', properties: {} }, requiresConfirmation: true, handler: async (a) => { sent.push(a); return { status: 'SUCCESS' }; } },
    ])]);
    const onConfirm = vi.fn(async () => ({ approved: true }));
    const res = await runRecipe(assetSendRecipe, 'send 10 usdt to bob', { provider: approve, tools, onConfirm });
    expect(res.status).toBe('done');
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(sent[0]).toEqual({ asset: 'USDT', amount: 10, to: 'bob@x.com' });
  });
});

describe('RecipeRegistry', () => {
  it('selects by trigger', () => {
    const reg = new RecipeRegistry([paymentsRecipe]);
    expect(reg.select('pay bob 3 eur')?.name).toBe('pay-contact');
    expect(reg.select('what is my balance')).toBeNull();
  });
});
