/** Confirm-sheet readback — deterministic, voice-first spend summaries. */

import { describe, it, expect } from 'vitest';
import { confirmReadback } from './confirm.js';

describe('confirmReadback', () => {
  it('send_payment: sats + recipient, grouped thousands', () => {
    expect(confirmReadback({ name: 'send_payment', arguments: { to: 'bob', amount_sats: 4800 } }))
      .toBe('Send 4,800 sats to bob. Confirm?');
  });

  it('send_payment: explicit layer is read back', () => {
    expect(confirmReadback({ name: 'send_payment', arguments: { to: 'bob', amount_sats: 1000000, layer: 'spark' } }))
      .toBe('Send 1,000,000 sats to bob over Spark. Confirm?');
  });

  it('send_payment: asset amount when no sats (core router, no layer suffix)', () => {
    expect(confirmReadback({ name: 'send_payment', arguments: { to: 'alice', asset: 'USDT', amount: 10 } }))
      .toBe('Send 10 USDT to alice. Confirm?');
  });

  it('spark_send: layer comes from the tool, address is shortened', () => {
    const line = confirmReadback({
      name: 'spark_send',
      arguments: { amount_sats: 5000, to: 'bc1qabcdef0123456789xyzlongaddress' },
    });
    expect(line).toBe('Send 5,000 sats to bc1qab…ress over Spark. Confirm?');
  });

  it('rln_send_asset: asset + ticker + recipient over RLN', () => {
    expect(confirmReadback({ name: 'rln_send_asset', arguments: { asset: 'USDT', amount: 10, to: 'bob' } }))
      .toBe('Send 10 USDT to bob over RLN. Confirm?');
  });

  it('rln_pay_invoice: invoice shortened, over RLN', () => {
    const line = confirmReadback({
      name: 'rln_pay_invoice',
      arguments: { invoice: 'lnbc1ptestinvoice0123456789abcd' },
    });
    expect(line).toBe('Pay Lightning invoice lnbc1p…abcd over RLN. Confirm?');
  });

  it('execute_swap: from → to with amount', () => {
    expect(confirmReadback({ name: 'execute_swap', arguments: { from_asset: 'BTC', to_asset: 'USDT', amount: 0.01 } }))
      .toBe('Swap 0.01 BTC for USDT. Confirm?');
  });

  it('returns null for non-spend tools', () => {
    expect(confirmReadback({ name: 'get_balances', arguments: {} })).toBeNull();
    expect(confirmReadback({ name: 'resolve_contact', arguments: { name: 'bob' } })).toBeNull();
  });

  it('short contact names are not truncated; long refs are', () => {
    expect(confirmReadback({ name: 'arkade_send', arguments: { amount_sats: 100, to: 'mum' } }))
      .toBe('Send 100 sats to mum over Arkade. Confirm?');
  });
});
