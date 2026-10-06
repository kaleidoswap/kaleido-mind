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

  it('spark_pay_invoice: same readback shape, over Spark', () => {
    const line = confirmReadback({
      name: 'spark_pay_invoice',
      arguments: { invoice: 'lnbc1ptestinvoice0123456789abcd' },
    });
    expect(line).toBe('Pay Lightning invoice lnbc1p…abcd over Spark. Confirm?');
  });

  it('rln_send_asset: kaleido-mcp argument names', () => {
    expect(confirmReadback({ name: 'rln_send_asset', arguments: { asset_id: 'rgb:abcdefgh-1234567890-xyz', amount: 5, recipient_id: 'utxob:ab12cd34ef56gh78ij90' } }))
      .toBe('Send 5 rgb:ab…-xyz to utxob:…ij90 over RLN. Confirm?');
  });

  it('rln_send_btc / channel / atomic taker readbacks', () => {
    expect(confirmReadback({ name: 'rln_send_btc', arguments: { address: 'tb1qexampleaddress0000000000xyz', amount_sat: 25000 } }))
      .toBe('Send 25,000 sats on-chain to tb1qex…0xyz over RLN. Confirm?');
    expect(confirmReadback({ name: 'rln_open_channel', arguments: { peer_pubkey_and_addr: '03abcdef0123456789abcdef0123456789@1.2.3.4:9735', capacity_sat: 100000 } }))
      .toBe('Open a 100,000 sats channel to 03abcd…6789. Confirm?');
    expect(confirmReadback({ name: 'rln_close_channel', arguments: { channel_id: 'chan0123456789abcdef0123', peer_pubkey: 'x', force: true } }))
      .toBe('Force-close channel chan01…0123. Confirm?');
    expect(confirmReadback({ name: 'rln_atomic_taker', arguments: { swapstring: '30/rgb:asset/10/btc/3600/abcdef0123456789' } }))
      .toBe('Accept atomic swap 30/rgb…6789 on your node. Confirm?');
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
