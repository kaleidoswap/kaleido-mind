/**
 * L402 tool tests — the "agent pays for a tool in sats" flow, deterministic
 * with a stubbed fetch. No network, no model.
 */

import { describe, it, expect, vi } from 'vitest';
import { createL402ToolSource, parseL402Challenge, bolt11AmountSats } from './l402.js';

describe('L402 helpers', () => {
  it('parses an L402 challenge header', () => {
    const h = 'L402 macaroon="AbCdEf==", invoice="lnbc100n1xyz"';
    expect(parseL402Challenge(h)).toEqual({ macaroon: 'AbCdEf==', invoice: 'lnbc100n1xyz' });
  });

  it('returns null when the header is not an L402 challenge', () => {
    expect(parseL402Challenge('Bearer xyz')).toBeNull();
  });

  it('parses bolt11 amounts to sats', () => {
    expect(bolt11AmountSats('lnbc100n1xyz')).toBe(10); // 100 nano-BTC = 10 sats
    expect(bolt11AmountSats('lnbc1u1xyz')).toBe(100); // 1 micro-BTC = 100 sats
    expect(bolt11AmountSats('lnbc2500u1xyz')).toBe(250_000);
  });
});

describe('createL402ToolSource — pay-and-fetch flow', () => {
  it('pays the invoice on 402 then re-fetches with the L402 token', async () => {
    const payInvoice = vi.fn(async () => ({ preimage: 'deadbeefpreimage' }));

    // First call → 402 with a challenge; second (authed) call → 200 with data.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        status: 402,
        ok: false,
        headers: new Map([
          ['www-authenticate', 'L402 macaroon="MAC123", invoice="lnbc100n1demo"'],
        ]) as any,
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Map() as any,
        async text() {
          return JSON.stringify({ btc_usd: 73000 });
        },
      });

    const src = createL402ToolSource({ payInvoice, fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await src.execute('fetch_paid_resource', { url: 'https://api.example/premium/price' });

    // paid the right invoice + amount (100n = 10 sats)
    expect(payInvoice).toHaveBeenCalledWith('lnbc100n1demo', 10);
    // second fetch carried the L402 Authorization header
    const secondCallArgs = fetchImpl.mock.calls[1];
    expect(secondCallArgs[1].headers.Authorization).toBe('L402 MAC123:deadbeefpreimage');
    // returned the parsed JSON resource
    expect(result).toEqual({ btc_usd: 73000 });
  });

  it('returns the resource directly when no payment is required (200)', async () => {
    const payInvoice = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: new Map() as any,
      async text() {
        return 'plain text resource';
      },
    });
    const src = createL402ToolSource({ payInvoice, fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await src.execute('fetch_paid_resource', { url: 'https://api.example/free' });

    expect(payInvoice).not.toHaveBeenCalled();
    expect(result).toBe('plain text resource');
  });

  it('exposes the tool with confirmation required (money tool)', () => {
    const src = createL402ToolSource({ payInvoice: vi.fn() });
    const tools = src.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('fetch_paid_resource');
    expect(tools[0].requiresConfirmation).toBe(true);
  });

  it('honours requiresConfirmation: false (auto-pay hosts)', () => {
    const src = createL402ToolSource({ payInvoice: vi.fn(), requiresConfirmation: false });
    expect(src.listTools()[0].requiresConfirmation).toBe(false);
  });

  it('declines invoices above maxAutoPaySats', async () => {
    const payInvoice = vi.fn(async () => ({ preimage: 'x' }));
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      status: 402,
      ok: false,
      headers: new Map([
        // 2500u = 250,000 sats — above the 1000 cap
        ['www-authenticate', 'L402 macaroon="M", invoice="lnbc2500u1big"'],
      ]) as any,
    });
    const src = createL402ToolSource({
      payInvoice,
      maxAutoPaySats: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(src.execute('fetch_paid_resource', { url: 'https://x/y' })).rejects.toThrow(
      /above the 1000 sat auto-pay cap/,
    );
    expect(payInvoice).not.toHaveBeenCalled();
  });
});
