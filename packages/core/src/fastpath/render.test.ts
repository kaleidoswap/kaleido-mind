import { describe, it, expect } from 'vitest';
import { defaultRenderFast } from './render.js';
import { FastPath, WALLET_FAST_INTENTS } from './fastpath.js';

const fp = new FastPath(WALLET_FAST_INTENTS);

describe('fast path: RLN tools and RGB assets', () => {
  it('lists fallback tools after the primary one', () => {
    expect(fp.select('What is my on-chain BTC balance?')?.tools).toEqual(['get_balances', 'rln_get_balances', 'wdk_get_balances']);
  });

  it('routes asset questions, not asset actions', () => {
    expect(fp.select('Which RGB assets do I hold, and what are the balances?')?.intent.name).toBe('assets');
    expect(fp.select('list my tokens')?.intent.name).toBe('assets');
    expect(fp.select('Issue a new RGB asset named FOO')).toBeNull();
    expect(fp.select('Create an RGB invoice so I can receive 10 USDT')).toBeNull();
    expect(fp.select('Send 1 USDT to rgb:abc')).toBeNull();
  });

  it('renders the kaleido-mcp, aggregate and MockWallet balance shapes', () => {
    expect(
      defaultRenderFast(
        'balance',
        JSON.stringify({ btc_onchain: { vanilla_spendable_sats: 4277, colored_spendable_sats: 195000 }, lightning_balance_sat: 0 }),
      ),
    ).toBe('On-chain: 4,277 sats spendable.\nRGB UTXOs: 195,000 sats (holding RGB assets, not for spending).\nLightning: 0 sats.');
    expect(defaultRenderFast('balance', { total_sats: 1000, layers: [{}, {}] })).toBe('You have 1,000 sats across 2 layers.');
    expect(defaultRenderFast('balance', { btc_sats: 300000 })).toBe('You have 300,000 sats.');
  });

  it('renders RGB assets with their ticker and precision', () => {
    const mcp = [
      { ticker: 'Q35A', name: 'Bench Q35A', precision: 0, balance: { spendable: 1_000_000 } },
      { ticker: 'USDT', name: 'Tether USD', precision: 6, balance: { spendable: 2_500_000 } },
    ];
    expect(defaultRenderFast('assets', mcp)).toBe('Your RGB assets:\n- Q35A (Bench Q35A): 1,000,000 Q35A\n- USDT (Tether USD): 2.5 USDT');
    expect(defaultRenderFast('assets', { assets: [] })).toBe("You don't hold any RGB assets yet.");
  });
});
