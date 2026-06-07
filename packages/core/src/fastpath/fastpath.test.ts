import { describe, it, expect } from 'vitest';
import { FastPath, WALLET_FAST_INTENTS } from './fastpath.js';

const fp = new FastPath(WALLET_FAST_INTENTS);

describe('FastPath (Tier-0)', () => {
  it('routes balance asks → get_balances', () => {
    expect(fp.select("what's my balance")?.tool).toBe('get_balances');
    expect(fp.select('how much do i have')?.tool).toBe('get_balances');
    expect(fp.select('show my funds')?.tool).toBe('get_balances');
  });

  it('routes receive-address asks → spark_get_address', () => {
    expect(fp.select('give me a receive address')?.tool).toBe('spark_get_address');
    expect(fp.select('what is my address')?.tool).toBe('spark_get_address');
  });

  it('routes price asks → get_price', () => {
    expect(fp.select('btc price')?.tool).toBe('get_price');
    expect(fp.select('how much is bitcoin')?.tool).toBe('get_price');
  });

  it('does NOT fire on spend / compound requests', () => {
    expect(fp.select('pay bob 3 eur')).toBeNull();
    expect(fp.select('send 5000 sats to alice')).toBeNull();
    expect(fp.select('check my balance and then send 1000 to bob')).toBeNull(); // compound → LLM
    expect(fp.select('swap 10 usdt for btc')).toBeNull();
  });

  it('does NOT fire on unrelated chatter', () => {
    expect(fp.select('hello there')).toBeNull();
    expect(fp.select('what can you do')).toBeNull();
  });
});
