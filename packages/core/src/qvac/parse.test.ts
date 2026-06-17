import { describe, it, expect } from 'vitest';
import { finalToTurn, extractTextToolCalls } from './parse.js';

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

  // The QVAC SDK / small models sometimes emit tool calls as plain text instead
  // of structured frames; finalToTurn must recover them so they still execute.
  describe('inline tool-call recovery (SDK gave no structured toolCalls)', () => {
    it('recovers a <tool_call> block and hides the tags from the answer', () => {
      const out = finalToTurn({
        contentText:
          '<tool_call> {"name": "rln_create_rgb_invoice", "arguments": {}} </tool_call>',
      });
      expect(out.toolCalls).toEqual([{ name: 'rln_create_rgb_invoice', arguments: {} }]);
      expect(out.text).toBe('');
    });

    it('keeps the trailing sentence after the tag out of the answer but runs the call', () => {
      const out = finalToTurn({
        contentText:
          '<tool_call> {"name": "rln_create_rgb_invoice", "arguments": {}} </tool_call> Please specify the asset ID.',
      });
      expect(out.toolCalls).toEqual([{ name: 'rln_create_rgb_invoice', arguments: {} }]);
      expect(out.text).toBe('Please specify the asset ID.');
    });

    it('recovers nested arguments', () => {
      const out = finalToTurn({
        contentText:
          '<tool_call> {"name": "lsp_get_order", "arguments": {"order_id": "latest", "access_token": "latest"}} </tool_call>',
      });
      expect(out.toolCalls).toEqual([
        { name: 'lsp_get_order', arguments: { order_id: 'latest', access_token: 'latest' } },
      ]);
    });

    it('recovers a bare leading tool-call object', () => {
      const out = finalToTurn({ contentText: '{"name": "get_balances", "arguments": {}}' });
      expect(out.toolCalls).toEqual([{ name: 'get_balances', arguments: {} }]);
    });

    it('does NOT recover when the SDK already returned structured calls', () => {
      const out = finalToTurn({
        contentText: '<tool_call> {"name": "ghost", "arguments": {}} </tool_call>',
        toolCalls: [{ name: 'real_tool', arguments: { a: 1 } }],
      });
      expect(out.toolCalls).toEqual([{ id: undefined, name: 'real_tool', arguments: { a: 1 } }]);
    });

    it('ignores JSON the model is merely talking about (not a call)', () => {
      const out = finalToTurn({
        contentText: 'A tool call looks like {"name": "x", "arguments": {}} in JSON.',
      });
      expect(out.toolCalls).toEqual([]);
      expect(out.text).toContain('A tool call looks like');
    });
  });

  describe('extractTextToolCalls', () => {
    it('extracts multiple tagged calls', () => {
      const calls = extractTextToolCalls(
        '<tool_call>{"name":"a","arguments":{}}</tool_call> and <tool_call>{"name":"b","arguments":{"x":1}}</tool_call>',
      );
      expect(calls).toEqual([
        { name: 'a', arguments: {} },
        { name: 'b', arguments: { x: 1 } },
      ]);
    });

    it('returns [] for plain prose', () => {
      expect(extractTextToolCalls('just a normal answer')).toEqual([]);
    });
  });
});
