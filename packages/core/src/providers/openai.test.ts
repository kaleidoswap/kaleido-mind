import { describe, it, expect } from 'vitest';
import { createOpenAICompatibleProvider, encodeToolCalls, toWireMessages } from './openai.js';

function sse(chunks: unknown[]): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text);
  // Split mid-line to exercise buffering.
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      ctl.enqueue(bytes.slice(0, 17));
      ctl.enqueue(bytes.slice(17));
      ctl.close();
    },
  });
  return new Response(body, { status: 200 });
}

function fakeFetch(responses: Response[]) {
  const bodies: any[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return responses.shift()!;
  }) as unknown as typeof fetch;
  return { fn, bodies };
}

const balanceTool = {
  name: 'get_balance',
  description: 'Wallet balance',
  parameters: { type: 'object', properties: { account: { type: 'string', enum: ['rln', 'spark'] } }, required: ['account'] },
};

describe('createOpenAICompatibleProvider', () => {
  it('streams text and reports usage', async () => {
    const { fn, bodies } = fakeFetch([
      sse([
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } },
      ]),
    ]);
    const p = createOpenAICompatibleProvider({ baseUrl: 'http://x/v1/', model: 'm', fetch: fn, defaultTemperature: 0.1 });
    const tokens: string[] = [];
    const out = await p.runTurn({ system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: [], onToken: (t) => tokens.push(t) });
    expect(out.text).toBe('Hello');
    expect(tokens).toEqual(['Hel', 'lo']);
    expect(out.inference).toMatchObject({ status: 'completed', promptTokens: 12, completionTokens: 2, stopReason: 'stop' });
    expect(bodies[0]).toMatchObject({ model: 'm', stream: true, temperature: 0.1, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }] });
    expect(bodies[0].tools).toBeUndefined();
  });

  it('assembles streamed tool-call fragments and sends tools + tool_choice', async () => {
    const { fn, bodies } = fakeFetch([
      sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_balance', arguments: '{"acc' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ount":"rln"}' } }] }, finish_reason: 'tool_calls' }] },
      ]),
    ]);
    const p = createOpenAICompatibleProvider({ baseUrl: 'http://x/v1', model: 'm', fetch: fn });
    const out = await p.runTurn({ messages: [{ role: 'user', content: 'balance' }], tools: [balanceTool], toolChoice: 'required' });
    expect(out.toolCalls).toEqual([{ id: 'c1', name: 'get_balance', arguments: { account: 'rln' } }]);
    expect(out.rawContent).toBe('<tool_call>{"name":"get_balance","arguments":{"account":"rln"}}</tool_call>');
    expect(bodies[0].tool_choice).toBe('required');
    expect(bodies[0].tools[0]).toEqual({ type: 'function', function: { name: 'get_balance', description: 'Wallet balance', parameters: balanceTool.parameters } });
  });

  it('maps a named tool choice and reports unparseable arguments as toolErrors', async () => {
    const { fn, bodies } = fakeFetch([
      sse([{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'get_balance', arguments: '{"account":"rl' } }] }, finish_reason: 'length' }] }]),
    ]);
    const p = createOpenAICompatibleProvider({ baseUrl: 'http://x/v1', model: 'm', fetch: fn });
    const out = await p.runTurn({ messages: [{ role: 'user', content: 'b' }], tools: [balanceTool], toolChoice: 'get_balance' });
    expect(bodies[0].tool_choice).toEqual({ type: 'function', function: { name: 'get_balance' } });
    expect(out.toolCalls).toEqual([]);
    expect(out.toolErrors?.[0]).toMatchObject({ code: 'PARSE_ERROR' });
    expect(out.inference?.status).toBe('truncated');
  });

  it('works without streaming', async () => {
    const res = new Response(
      JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'z', type: 'function', function: { name: 'get_balance', arguments: '{"account":"spark"}' } }] }, finish_reason: 'tool_calls' }] }),
    );
    const { fn, bodies } = fakeFetch([res]);
    const p = createOpenAICompatibleProvider({ baseUrl: 'http://x/v1', model: 'm', fetch: fn, stream: false, apiKey: 'k' });
    const out = await p.runTurn({ messages: [{ role: 'user', content: 'b' }], tools: [balanceTool] });
    expect(out.toolCalls).toEqual([{ id: 'z', name: 'get_balance', arguments: { account: 'spark' } }]);
    expect(bodies[0].stream).toBe(false);
  });

  it('throws on an HTTP error and returns a cancelled turn on abort', async () => {
    const p1 = createOpenAICompatibleProvider({ baseUrl: 'http://x/v1', model: 'm', fetch: fakeFetch([new Response('nope', { status: 500 })]).fn });
    await expect(p1.runTurn({ messages: [{ role: 'user', content: 'b' }], tools: [] })).rejects.toThrow(/500/);

    const abortingFetch = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
    const p2 = createOpenAICompatibleProvider({ baseUrl: 'http://x/v1', model: 'm', fetch: abortingFetch });
    const ctl = new AbortController();
    const pending = p2.runTurn({ messages: [{ role: 'user', content: 'b' }], tools: [], signal: ctl.signal });
    ctl.abort();
    expect((await pending).inference?.status).toBe('cancelled');
  });
});

describe('toWireMessages', () => {
  it('rebuilds tool_calls / tool_call_id pairs from engine history', () => {
    const raw = encodeToolCalls('Checking.', [
      { name: 'get_balance', arguments: { account: 'rln' } },
      { name: 'get_balance', arguments: { account: 'spark' } },
    ]);
    const wire = toWireMessages(
      [
        { role: 'user', content: 'balances?' },
        { role: 'assistant', content: raw },
        { role: 'tool', content: '{"sats":1}' },
        { role: 'tool', content: '{"sats":2}' },
        { role: 'tool', content: '{"error":"unreadable call"}' },
      ],
      'SYS',
    );
    expect(wire[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(wire[2]).toMatchObject({ role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'call_1_0' }, { id: 'call_1_1' }] });
    expect((wire[2] as any).tool_calls[1].function).toEqual({ name: 'get_balance', arguments: '{"account":"spark"}' });
    expect(wire[3]).toEqual({ role: 'tool', content: '{"sats":1}', tool_call_id: 'call_1_0' });
    expect(wire[4]).toEqual({ role: 'tool', content: '{"sats":2}', tool_call_id: 'call_1_1' });
    expect(wire[5]).toEqual({ role: 'user', content: 'Tool result: {"error":"unreadable call"}' });
  });
});
