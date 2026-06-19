/** parseMcpResult — JSON parsing + isError handling for MCP tool results. */

import { describe, it, expect } from 'vitest';
import { parseMcpResult } from './mcp.js';

describe('parseMcpResult', () => {
  it('parses JSON text content into an object (so recipes thread real fields)', () => {
    const res = { content: [{ type: 'text', text: '{"rfq_id":"abc","total_sat":1500}' }] };
    expect(parseMcpResult(res)).toEqual({ rfq_id: 'abc', total_sat: 1500 });
  });

  it('surfaces isError as an {error} object (so a failed spend is not "success")', () => {
    const res = { isError: true, content: [{ type: 'text', text: 'insufficient funds' }] };
    expect(parseMcpResult(res)).toEqual({ error: 'insufficient funds' });
  });

  it('errors with no text still produce an {error} object', () => {
    expect(parseMcpResult({ isError: true, content: [] })).toEqual({
      error: 'The tool reported an error.',
    });
  });

  it('passes non-JSON prose through unchanged', () => {
    const res = { content: [{ type: 'text', text: 'Bitcoin is digital cash.' }] };
    expect(parseMcpResult(res)).toBe('Bitcoin is digital cash.');
  });

  it('returns the content array when there is no text block', () => {
    const res = { content: [{ type: 'image', data: 'x' }] };
    expect(parseMcpResult(res)).toEqual([{ type: 'image', data: 'x' }]);
  });

  it('joins multiple text blocks before parsing', () => {
    const res = { content: [{ type: 'text', text: '{"a":1,' }, { type: 'text', text: '"b":2}' }] };
    expect(parseMcpResult(res)).toEqual({ a: 1, b: 2 });
  });
});
