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
    expect(confirmReadback({ name: 'rln_atomic_taker', arguments: { swapstring: '30/rgb:asset/10000/btc/3600/abcdef0123456789' } }))
      .toBe('Accept atomic swap 30 units of rgb:asset ⇄ 10 sats (30/rgb…6789). Confirm?');
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

describe('confirmReadback: LSP orders', () => {
  it('says what is ordered and that the total is paid separately', () => {
    expect(
      confirmReadback({ name: 'kaleidoswap_lsp_create_order', arguments: { client_pubkey: '02ab', lsp_balance_sat: 50000, client_balance_sat: 0, channel_expiry_blocks: 4320 } }),
    ).toBe('Order a Lightning channel from the LSP with 50,000 sats inbound. The order total is paid in a separate step. Confirm?');
    expect(
      confirmReadback({ name: 'kaleidoswap_lsp_create_asset_channel', arguments: { asset: 'USDT', asset_amount: 10, rfq_id: 'r' } }),
    ).toBe('Order a channel from the LSP with 10 USDT inbound. The order total is paid in a separate step. Confirm?');
  });
});

describe('confirmReadback: accepting an atomic swap', () => {
  const swapstring = '2500000/btc/1500000/rgb:usdt-abcdefgh/1791400000/ph1';
  const quote = {
    name: 'kaleidoswap_get_quote',
    result: { from_asset: { ticker: 'BTC', amount_display: '2,500 sats' }, to_asset: { ticker: 'USDT', amount_display: '1.5' } },
  };

  it("shows the run's quote amounts", () => {
    const init = { name: 'kaleidoswap_atomic_init', result: { swapstring, payment_hash: 'ph1' } };
    expect(confirmReadback({ name: 'rln_atomic_taker', arguments: { swapstring } }, { results: [quote, init] })).toBe(
      'Accept the atomic swap: you send 2,500 sats, you receive 1.5 USDT. Confirm?',
    );
  });

  it('flags a swapstring that is not the one just created', () => {
    const init = { name: 'kaleidoswap_atomic_init', result: { swapstring: 'other/btc/1/btc/1/x' } };
    expect(confirmReadback({ name: 'rln_atomic_taker', arguments: { swapstring } }, { results: [quote, init] })).toMatch(
      /\(this is not the swap just created\)\. Confirm\?$/,
    );
  });

  it('decodes the swapstring when there is no quote', () => {
    expect(confirmReadback({ name: 'wdk_atomic_taker', arguments: { swapstring } })).toMatch(
      /^Accept atomic swap 2,500 sats ⇄ 1,500,000 units of rgb:/,
    );
  });
});
