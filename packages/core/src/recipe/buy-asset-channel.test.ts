import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../tools/registry.js';
import { InProcessToolSource } from '../tools/in-process.js';
import type { LLMProvider } from '../providers/types.js';
import { runRecipe, RecipeRegistry } from './runner.js';
import { buyAssetChannelRecipe, extractBuyAsset } from './buy-asset-channel.js';
import { swapRecipe } from './swap.js';
import { assetSendRecipe } from './asset-send.js';

const approve: LLMProvider = { name: 'x', runTurn: async () => ({ text: '', rawContent: '', toolCalls: [] }) };

/** Stub the two asset-channel tools the recipe drives. */
function stubTools(spy?: { create?: (a: any) => void }) {
  return new ToolRegistry([
    new InProcessToolSource('ks', [
      {
        name: 'kaleidoswap_lsp_quote_asset_channel',
        description: '',
        parameters: { type: 'object', properties: {} },
        handler: async (a) => ({
          rfq_id: 'rfq1',
          asset_amount: a.asset_amount,
          btc_amount_sat: 13807,
          channel_fee_sat: 16139,
          total_sat: 29946,
          expires_at: 1234567890,
        }),
      },
      {
        name: 'kaleidoswap_lsp_create_asset_channel',
        description: '',
        parameters: { type: 'object', properties: {} },
        requiresConfirmation: true,
        handler: async (a) => {
          spy?.create?.(a);
          return { order_id: 'ord1', total_sat: 29946, payment: { onchain_address: 'bcrt1qexample' } };
        },
      },
    ]),
  ]);
}

describe('extractBuyAsset (deterministic Tier-0)', () => {
  it('parses "buy 100 usdt"', () => {
    expect(extractBuyAsset('buy 100 usdt')).toEqual({ asset: 'USDT', asset_amount: 100 });
  });
  it('parses "get me 50 xaut"', () => {
    expect(extractBuyAsset('get me 50 xaut')).toEqual({ asset: 'XAUT', asset_amount: 50 });
  });
  it('parses "i want 200 usdt" and "purchase 10 xaut"', () => {
    expect(extractBuyAsset('i want 200 usdt')).toEqual({ asset: 'USDT', asset_amount: 200 });
    expect(extractBuyAsset('purchase 10 xaut')).toEqual({ asset: 'XAUT', asset_amount: 10 });
  });
  it('handles comma grouping in the amount', () => {
    expect(extractBuyAsset('buy 1,000 usdt')).toEqual({ asset: 'USDT', asset_amount: 1000 });
  });
  it('parses an article/filler between the verb and amount ("buy a 100 usdt channel")', () => {
    expect(extractBuyAsset('buy a 100 usdt channel')).toEqual({ asset: 'USDT', asset_amount: 100 });
    expect(extractBuyAsset('get a 100 usdt inbound channel')).toEqual({ asset: 'USDT', asset_amount: 100 });
    expect(extractBuyAsset('buy and sell 100 usdt')).toBeNull(); // "and" is not filler
  });
  it('null for a swap (a named source asset ⇒ swap owns it)', () => {
    expect(extractBuyAsset('buy 0.001 btc with usdt')).toBeNull();
    expect(extractBuyAsset('swap 10 usdt for btc')).toBeNull();
    expect(extractBuyAsset('buy 100 usdt with my bitcoin')).toBeNull();
  });
  it('null for a send (asset-send owns it)', () => {
    expect(extractBuyAsset('send 10 usdt to bob')).toBeNull();
  });
  it('null for BTC (BTC is not bought via an asset channel)', () => {
    expect(extractBuyAsset('buy 100000 sats')).toBeNull();
    expect(extractBuyAsset('get 0.01 btc')).toBeNull();
  });
});

describe('runRecipe — buy asset channel', () => {
  it('quote → confirm → create order, deterministic (0 inferences)', async () => {
    const created: any[] = [];
    const tools = stubTools({ create: (a) => created.push(a) });
    const onConfirm = vi.fn(async () => ({ approved: true }));
    const res = await runRecipe(buyAssetChannelRecipe, 'buy 100 usdt', { provider: approve, tools, onConfirm });

    expect(res.status).toBe('done');
    expect(res.inferences).toBe(0);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(res.results.quote).toMatchObject({ rfq_id: 'rfq1' });
    expect(created[0]).toMatchObject({ asset: 'USDT', asset_amount: 100, rfq_id: 'rfq1' });
    // The quote's cost rides along for the confirm card.
    expect(created[0]).toMatchObject({ total_sat: 29946, btc_amount_sat: 13807, channel_fee_sat: 16139 });
    expect(res.text).toContain('100 USDT');
    expect(res.text).toContain('29,946');
  });

  it('denied confirmation → cancelled, no order placed', async () => {
    const created: any[] = [];
    const tools = stubTools({ create: (a) => created.push(a) });
    const res = await runRecipe(buyAssetChannelRecipe, 'buy 100 usdt', {
      provider: approve,
      tools,
      onConfirm: async () => ({ approved: false }),
    });
    expect(res.status).toBe('cancelled');
    expect(created).toHaveLength(0);
  });

  it('fails closed when no confirm handler is wired (spend never runs)', async () => {
    const created: any[] = [];
    const tools = stubTools({ create: (a) => created.push(a) });
    const res = await runRecipe(buyAssetChannelRecipe, 'buy 100 usdt', { provider: approve, tools });
    expect(res.status).toBe('cancelled');
    expect(created).toHaveLength(0);
  });

  it('falls back to ONE LLM extraction when the regex misses', async () => {
    const created: any[] = [];
    const tools = stubTools({ create: (a) => created.push(a) });
    const llmOnly = { ...buyAssetChannelRecipe, extract: undefined };
    const provider: LLMProvider = {
      name: 'mock',
      runTurn: vi.fn(async () => ({
        text: '',
        rawContent: '',
        toolCalls: [{ id: '1', name: 'extract_request', arguments: { asset: 'USDT', asset_amount: 100 } }],
      })),
    };
    const res = await runRecipe(llmOnly, 'could you set me up with a hundred tether', {
      provider,
      tools,
      onConfirm: async () => ({ approved: true }),
    });
    expect(res.inferences).toBe(1);
    expect(provider.runTurn).toHaveBeenCalledOnce();
    expect(created[0]).toMatchObject({ asset: 'USDT', asset_amount: 100, rfq_id: 'rfq1' });
  });
});

describe('recipe selection / precedence', () => {
  it('selects buy-asset-channel before swap for "buy 100 usdt"', () => {
    const reg = new RecipeRegistry([buyAssetChannelRecipe, swapRecipe]);
    expect(reg.select('buy 100 usdt')?.name).toBe('buy-asset-channel');
    expect(reg.select('get me 50 xaut')?.name).toBe('buy-asset-channel');
  });
  it('does not hijack a swap or an asset send', () => {
    const reg = new RecipeRegistry([buyAssetChannelRecipe, swapRecipe, assetSendRecipe]);
    expect(reg.select('swap 10 usdt for btc')?.name).not.toBe('buy-asset-channel');
    expect(reg.select('send 10 usdt to bob')?.name).not.toBe('buy-asset-channel');
  });
  it('confident only with both asset and a positive amount', () => {
    expect(buyAssetChannelRecipe.confident!({ asset: 'USDT', asset_amount: 100 })).toBe(true);
    expect(buyAssetChannelRecipe.confident!({ asset: 'USDT' })).toBe(false);
    expect(buyAssetChannelRecipe.confident!({ asset: 'USDT', asset_amount: 0 })).toBe(false);
  });
});
