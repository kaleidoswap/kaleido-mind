import { describe, it, expect } from 'vitest';
import { finalToTurn } from './parse.js';

describe('finalToTurn', () => {
  it('uses contentText for visible text and strips reasoning', () => {
    const out = finalToTurn({ contentText: '<think>x</think>Hello' });
    expect(out.text).toBe('Hello');
  });

  it('falls back to the streamed text when contentText is empty', () => {
    const out = finalToTurn({ contentText: '' }, 'streamed answer');
    expect(out.text).toBe('streamed answer');
  });

  it('prefers raw.fullText for rawContent (history push-back)', () => {
    const out = finalToTurn({ contentText: 'Hi', raw: { fullText: 'FRAMED<tool/>Hi' } });
    expect(out.rawContent).toBe('FRAMED<tool/>Hi');
    expect(out.text).toBe('Hi');
  });

  it('falls back to the raw text for rawContent when no framed form', () => {
    const out = finalToTurn({ contentText: 'Hi' });
    expect(out.rawContent).toBe('Hi');
  });

  it('maps tool calls and defaults missing arguments to {}', () => {
    const out = finalToTurn({
      contentText: '',
      toolCalls: [{ id: 'a', name: 'get_balance' }, { name: 'send', arguments: { sats: 5000 } }],
    });
    expect(out.toolCalls).toEqual([
      { id: 'a', name: 'get_balance', arguments: {} },
      { id: undefined, name: 'send', arguments: { sats: 5000 } },
    ]);
  });

  it('flags truncation when the SDK stops on length', () => {
    const out = finalToTurn({ contentText: 'partial', stopReason: 'length' });
    expect(out.truncated).toBe(true);
    expect(out.stopReason).toBe('length');
  });

  it('does not flag truncation on a natural stop', () => {
    const out = finalToTurn({ contentText: 'done' });
    expect(out.truncated).toBe(false);
  });

  it('handles an empty final without throwing', () => {
    const out = finalToTurn({});
    expect(out).toEqual({ text: '', rawContent: '', toolCalls: [], truncated: false, stopReason: undefined });
  });
});
