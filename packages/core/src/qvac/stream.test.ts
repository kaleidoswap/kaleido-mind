import { describe, it, expect } from 'vitest';
import { consumeRun, type CompletionEventLike, type CompletionRunLike } from './stream.js';
import type { QvacFinalLike } from './parse.js';

function fakeRun(
  events: CompletionEventLike[],
  final: QvacFinalLike,
  requestId = 'req-1',
): CompletionRunLike {
  return {
    requestId,
    events: (async function* () {
      for (const e of events) yield e;
    })(),
    final: Promise.resolve(final),
  };
}

describe('consumeRun', () => {
  it('forwards visible content tokens and accumulates the streamed fallback', async () => {
    const tokens: string[] = [];
    const run = fakeRun(
      [
        { type: 'contentDelta', text: 'Hel' },
        { type: 'contentDelta', text: 'lo' },
      ],
      { contentText: '', toolCalls: [], raw: { fullText: '' } },
    );
    const out = await consumeRun(run, { onToken: (t) => tokens.push(t) });
    expect(tokens).toEqual(['Hel', 'lo']);
    // contentText empty ⇒ falls back to the streamed accumulation.
    expect(out.text).toBe('Hello');
  });

  it('routes thinkingDelta to onThinking, not onToken', async () => {
    const visible: string[] = [];
    const thinking: string[] = [];
    const run = fakeRun(
      [
        { type: 'thinkingDelta', text: 'plan…' },
        { type: 'contentDelta', text: 'Answer' },
      ],
      { contentText: 'Answer', toolCalls: [], raw: { fullText: 'Answer' } },
    );
    await consumeRun(run, {
      onToken: (t) => visible.push(t),
      onThinking: (t) => thinking.push(t),
    });
    expect(visible).toEqual(['Answer']);
    expect(thinking).toEqual(['plan…']);
  });

  it('returns parsed tool calls + requestId and flags truncation from stopReason', async () => {
    const run = fakeRun(
      [],
      {
        contentText: 'partial',
        toolCalls: [{ id: 't1', name: 'get_balance', arguments: {} }],
        raw: { fullText: 'partial' },
        stopReason: 'length',
      },
      'req-xyz',
    );
    const out = await consumeRun(run);
    expect(out.requestId).toBe('req-xyz');
    expect(out.toolCalls).toEqual([{ id: 't1', name: 'get_balance', arguments: {} }]);
    expect(out.truncated).toBe(true);
  });

  it('stops forwarding and flags when thinking exceeds maxThinkingTokens', async () => {
    const thinking: string[] = [];
    let exceeded = 0;
    // 8-char deltas ≈ 2 tokens each; budget 4 tokens trips after the 2nd.
    const run = fakeRun(
      [
        { type: 'thinkingDelta', text: 'aaaaaaaa' },
        { type: 'thinkingDelta', text: 'bbbbbbbb' },
        { type: 'thinkingDelta', text: 'cccccccc' },
        { type: 'contentDelta', text: 'should-not-arrive' },
      ],
      { contentText: '', toolCalls: [], raw: { fullText: '' }, stopReason: 'cancelled' },
    );
    const out = await consumeRun(run, {
      onThinking: (t) => thinking.push(t),
      maxThinkingTokens: 4,
      onThinkingBudgetExceeded: () => {
        exceeded += 1;
      },
    });
    expect(exceeded).toBe(1);
    expect(out.thinkingBudgetExceeded).toBe(true);
    expect(thinking).toEqual(['aaaaaaaa', 'bbbbbbbb']); // stopped at the trip
  });

  it('ignores delta events with no text', async () => {
    const tokens: string[] = [];
    const run = fakeRun(
      [{ type: 'contentDelta' }, { type: 'toolCall' }, { type: 'contentDelta', text: 'hi' }],
      { contentText: 'hi', toolCalls: [], raw: { fullText: 'hi' } },
    );
    await consumeRun(run, { onToken: (t) => tokens.push(t) });
    expect(tokens).toEqual(['hi']);
  });
});
