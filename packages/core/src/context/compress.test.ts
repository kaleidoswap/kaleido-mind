/** Tool-output compression tests — savings + the safety guarantees. */

import { describe, it, expect } from 'vitest';
import { compressToolResult } from './compress.js';
import { estimateTokens } from './budget.js';

/** Build a verbose merchant-list-like result the agentic loop would crush. */
function merchants(n: number): { results: Array<Record<string, unknown>> } {
  return {
    results: Array.from({ length: n }, (_, i) => ({
      name: `Coffee Shop ${i}`,
      category: 'cafe',
      description:
        'Accepts Bitcoin on-chain and Lightning. Open daily. ' +
        'A cozy spot with reliable wifi and great espresso for digital nomads.',
      lat: 41.0 + i / 1000,
      lng: 12.0 + i / 1000,
      tags: ['bitcoin', 'lightning', 'cafe'],
    })),
  };
}

describe('compressToolResult', () => {
  it('passes small results through untouched', () => {
    const small = { total_sats: 123_456, layers: 2 };
    const r = compressToolResult(small);
    expect(r.changed).toBe(false);
    expect(r.content).toBe(JSON.stringify(small));
  });

  it('elides the middle of a long array and reports the omitted count', () => {
    const r = compressToolResult(merchants(40), { maxArrayItems: 6 });
    expect(r.changed).toBe(true);
    expect(r.compressedTokens).toBeLessThan(r.originalTokens);
    expect(r.elided).toBeGreaterThan(0);

    const parsed = JSON.parse(r.content) as { results: Array<Record<string, unknown>> };
    const marker = parsed.results.find((x) => '__elided__' in x);
    expect(marker).toBeDefined();
    expect(marker!.__elided__).toBe(r.elided);
    // Kept first/last anchors → fewer items than the original 40.
    expect(parsed.results.length).toBeLessThan(40);
  });

  it('dedupes identical array items before eliding', () => {
    const dup = { rows: Array.from({ length: 30 }, () => ({ status: 'ok', code: 200 })) };
    const r = compressToolResult(dup, { maxArrayItems: 4 });
    const parsed = JSON.parse(r.content) as { rows: Array<Record<string, unknown>> };
    const real = parsed.rows.filter((x) => !('__elided__' in x));
    // 30 identical rows collapse to a single unique row (≤ maxArrayItems).
    expect(real.length).toBe(1);
  });

  it('never regresses: returns the original when crushing would not save tokens', () => {
    // A flat array of unique short numbers compresses to roughly itself; the
    // elision marker can cost more than it saves — must fall back to original.
    const flat = { xs: Array.from({ length: 60 }, (_, i) => i) };
    const r = compressToolResult(flat, { maxArrayItems: 50, dedupe: false });
    expect(r.compressedTokens).toBeLessThanOrEqual(r.originalTokens);
  });

  it('SAFETY: never truncates whitespace-free identifiers (invoices/addresses)', () => {
    const invoice = 'lnbc' + '1'.repeat(1500); // long BOLT11-like, no spaces
    const addr = 'bc1q' + 'a'.repeat(800);
    const payload = {
      filler: Array.from({ length: 20 }, (_, i) => ({ note: 'x'.repeat(50), i })),
      invoice,
      address: addr,
    };
    const r = compressToolResult(payload, { maxArrayItems: 4, maxStringLength: 80 });
    expect(r.content).toContain(invoice); // intact, not truncated
    expect(r.content).toContain(addr);
  });

  it('SAFETY: never elides/truncates values under preserved money keys', () => {
    const payload = {
      // A long prose string under a preserve key stays intact.
      balance: 'x '.repeat(1000),
      // Numbers are never touched regardless.
      total_sats: 4_800_123,
      history: Array.from({ length: 40 }, (_, i) => ({ memo: 'spent on coffee number ' + i, i })),
    };
    const r = compressToolResult(payload, { maxArrayItems: 4, maxStringLength: 40 });
    const parsed = JSON.parse(r.content) as Record<string, unknown>;
    expect(parsed.balance).toBe(payload.balance); // preserved verbatim
    expect(parsed.total_sats).toBe(4_800_123);
  });

  it('SAFETY: numbers are never altered', () => {
    const payload = {
      quotes: Array.from({ length: 30 }, (_, i) => ({
        amount_sats: 1000 + i,
        rate: 0.00012345,
        fee: 7,
      })),
    };
    const r = compressToolResult(payload, { maxArrayItems: 5 });
    const parsed = JSON.parse(r.content) as { quotes: Array<Record<string, number>> };
    for (const q of parsed.quotes) {
      if ('__elided__' in q) continue;
      expect(Number.isInteger(q.amount_sats)).toBe(true);
      expect(q.rate).toBe(0.00012345);
      expect(q.fee).toBe(7);
    }
  });

  it('truncates long prose strings (with whitespace) when over the limit', () => {
    const payload = { log: ('error happened at step ').repeat(200) };
    const r = compressToolResult(payload, { maxStringLength: 100, minTokens: 1 });
    expect(r.changed).toBe(true);
    expect(r.content).toContain('… (+');
    expect(estimateTokens(r.content)).toBeLessThan(r.originalTokens);
  });

  it('collapses nesting beyond maxDepth to a shape summary', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } }, pad: 'p'.repeat(900) };
    const r = compressToolResult(deep, { maxDepth: 3, minTokens: 1 });
    expect(r.content).toMatch(/\[object: \d+ keys\]/);
  });
});
