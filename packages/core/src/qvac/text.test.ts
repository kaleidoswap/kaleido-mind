import { describe, it, expect } from 'vitest';
import { cleanAssistantVisibleText, sanitizeForSupertonic } from './text.js';

describe('cleanAssistantVisibleText', () => {
  it('strips a closed <think> block', () => {
    expect(cleanAssistantVisibleText('<think>plan the answer</think>Your balance is 5k sats.'))
      .toBe('Your balance is 5k sats.');
  });

  it('strips an unclosed <think> tail', () => {
    expect(cleanAssistantVisibleText('Done.<think>still reasoning'))
      .toBe('Done.');
  });

  it('drops a leading tool-call prefix and keeps the sentence after it', () => {
    // The heuristic strips up to `"arguments":` then one `{`. Cleanly recovers
    // the tail when the model emits the framing without real JSON args.
    const raw = '{"name":"get_balance","arguments": You have 5,000 sats.';
    expect(cleanAssistantVisibleText(raw)).toBe('You have 5,000 sats.');
  });

  it('is lossy when real JSON args follow (known heuristic limit, stray braces remain)', () => {
    // Documents current behaviour verbatim from rate; a candidate for a future
    // balanced-brace fix once it can be re-verified on device.
    const raw = '{"name":"get_balance","arguments":{}} You have 5,000 sats.';
    expect(cleanAssistantVisibleText(raw)).toBe('}} You have 5,000 sats.');
  });

  it('collapses whitespace and trims', () => {
    expect(cleanAssistantVisibleText('  hello   world  ')).toBe('hello world');
  });

  it('leaves plain text untouched', () => {
    expect(cleanAssistantVisibleText('Sent 3 EUR to bob.')).toBe('Sent 3 EUR to bob.');
  });
});

describe('sanitizeForSupertonic', () => {
  it('redacts a bolt11 lightning invoice', () => {
    const out = sanitizeForSupertonic('Pay lnbc1' + 'q'.repeat(60) + ' now');
    expect(out).toContain('Lightning invoice');
    expect(out).not.toMatch(/lnbc1q/i);
  });

  it('redacts an lnurl string', () => {
    const out = sanitizeForSupertonic('Use lnurl1' + 'a'.repeat(50));
    expect(out).toContain('Lightning payment link');
    expect(out).not.toMatch(/lnurl1a/i);
  });

  it('strips fenced code blocks and inline backticks', () => {
    const out = sanitizeForSupertonic('Run ```rm -rf``` or `ls` here');
    expect(out).not.toContain('`');
    expect(out).toContain('ls');
  });

  it('removes the backtick character (U+0060) entirely', () => {
    const out = sanitizeForSupertonic('a`b`c');
    expect(Array.from(out).some((ch) => ch.charCodeAt(0) === 0x60)).toBe(false);
  });

  it('normalizes smart quotes to ASCII', () => {
    const out = sanitizeForSupertonic('“hello” ‘world’');
    expect(out).toBe('"hello" \'world\'');
  });

  it('drops non-ASCII and collapses whitespace', () => {
    expect(sanitizeForSupertonic('café   ✨ ok')).toBe('caf ok');
  });
});
