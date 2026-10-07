import { describe, it, expect } from 'vitest';
import { annotateRgbBalances, fixRgbBalanceUnits, formatRgbAmount } from './rgb-units.js';

const LIST = {
  assets: [
    { asset_id: 'rgb:usdt', ticker: 'USDT', name: 'Tether USD', precision: 0, balance: { settled: 1000, spendable: 1000 } },
    { asset_id: 'rgb:xaut', ticker: 'XAUT', name: 'Tether Gold', precision: 0, balance: { spendable: 2 } },
    { asset_id: 'rgb:dec', ticker: 'DEC', precision: 6, balance: { spendable: 1_500_000 } },
  ],
};

describe('RGB balance units', () => {
  it('formats raw amounts with the asset precision', () => {
    expect(formatRgbAmount(1_500_000, 6)).toBe('1.5');
    expect(formatRgbAmount(1_000_000, 0)).toBe('1,000,000');
  });

  it('adds balance_display next to each asset balance without touching the rest', () => {
    const out = annotateRgbBalances(LIST) as typeof LIST & { assets: Array<{ balance_display: Record<string, string> }> };
    expect(out.assets[0]!.balance_display).toEqual({ settled: '1,000 USDT', spendable: '1,000 USDT' });
    expect(out.assets[2]!.balance_display).toEqual({ spendable: '1.5 DEC' });
    expect(out.assets[0]!.balance).toEqual({ settled: 1000, spendable: 1000 });
    expect(annotateRgbBalances({ vanilla: { spendable: 4277 } })).toEqual({ vanilla: { spendable: 4277 } });
  });

  it('relabels the asset balances the 2B model called satoshis', () => {
    const answer =
      'You hold two RGB assets:\n1. **USDT** (Tether USD)\n   - Balance: 1,000 satoshis (spendable)\n' +
      '2. **XAUT** (Tether Gold)\n   - Balance: 2 satoshis (spendable)';
    expect(fixRgbBalanceUnits(answer, [LIST])).toBe(
      'You hold two RGB assets:\n1. **USDT** (Tether USD)\n   - Balance: 1,000 USDT (spendable)\n' +
        '2. **XAUT** (Tether Gold)\n   - Balance: 2 XAUT (spendable)',
    );
    expect(fixRgbBalanceUnits('DEC balance: 1,500,000 sats', [LIST])).toBe('DEC balance: 1.5 DEC');
  });

  it('leaves real sats and unmatched numbers alone', () => {
    const btc = { btc: { vanilla: { spendable: 4277 } } };
    expect(fixRgbBalanceUnits('Your on-chain balance is 4,277 sats.', [btc, LIST])).toBe('Your on-chain balance is 4,277 sats.');
    expect(fixRgbBalanceUnits('USDT channel fee: 300 sats', [LIST])).toBe('USDT channel fee: 300 sats');
  });
});
