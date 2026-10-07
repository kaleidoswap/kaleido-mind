import { describe, it, expect, vi } from 'vitest';
import { createQvacProvider } from './provider.js';

/** A fake `completion` that records its params and replays scripted events. */
function fakeCompletion(
  final: Record<string, unknown>,
  events: Array<{ type: string; text?: string }> = [],
) {
  const calls: any[] = [];
  const fn = (params: any) => {
    calls.push(params);
    return {
      requestId: 'req-1',
      events: (async function* () {
        for (const e of events) yield e;
      })(),
      final: Promise.resolve(final),
    };
  };
  return { fn, calls };
}

const noopCancel = (async () => {}) as any;

describe('createQvacProvider.runTurn', () => {
  it('throws when no model is loaded', async () => {
    const p = createQvacProvider({
      completion: (() => { throw new Error('should not be called'); }) as any,
      cancel: noopCancel,
      getModelId: () => null,
    });
    await expect(p.runTurn({ messages: [{ role: 'user', content: 'hi' }], tools: [] }))
      .rejects.toThrow(/not loaded/);
  });

  it('prepends the system message and sets generationParams + captureThinking', async () => {
    const { fn, calls } = fakeCompletion({ contentText: 'Hello', toolCalls: [], raw: { fullText: 'Hello' } });
    const p = createQvacProvider({
      completion: fn as any,
      cancel: noopCancel,
      getModelId: () => 'm1',
      defaultTemperature: 0.5,
      defaultMaxTokens: 256,
    });
    const out = await p.runTurn({ system: 'You are X', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(out.text).toBe('Hello');

    const params = calls[0];
    expect(params.modelId).toBe('m1');
    expect(params.history).toEqual([
      { role: 'system', content: 'You are X' },
      { role: 'user', content: 'hi' },
    ]);
    expect(params.stream).toBe(true);
    expect(params.captureThinking).toBe(true);
    expect(params.generationParams).toEqual({ temp: 0.5, predict: 256 });
    expect(params.tools).toBeUndefined();
  });

  it('maps tools by schema and honours per-call temperature/maxTokens', async () => {
    const { fn, calls } = fakeCompletion({
      contentText: '',
      toolCalls: [{ id: 'a', name: 'get_balance', arguments: {} }],
      raw: { fullText: '' },
    });
    const p = createQvacProvider({ completion: fn as any, cancel: noopCancel, getModelId: () => 'm1' });
    const out = await p.runTurn({
      messages: [{ role: 'user', content: 'balance?' }],
      tools: [{ name: 'get_balance', description: 'balance', parameters: { shape: true } }],
      temperature: 0.9,
      maxTokens: 99,
    } as any);

    expect(out.toolCalls).toEqual([{ id: 'a', name: 'get_balance', arguments: {} }]);
    const params = calls[0];
    expect(params.tools).toEqual([{ name: 'get_balance', description: 'balance', parameters: { shape: true } }]);
    expect(params.generationParams).toEqual({ temp: 0.9, predict: 99 });
  });

  it('sends JSON-Schema tools in the SDK Tool shape so arguments survive', async () => {
    const { fn, calls } = fakeCompletion({ contentText: 'ok', toolCalls: [], raw: { fullText: 'ok' } });
    const p = createQvacProvider({ completion: fn as any, cancel: noopCancel, getModelId: () => 'm1' });
    await p.runTurn({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'echo', description: 'e', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
    });
    expect(calls[0].tools).toEqual([
      { type: 'function', name: 'echo', description: 'e', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    ]);
  });

  it('omits generationParams when no temperature/maxTokens is set (keeps SDK defaults)', async () => {
    const { fn, calls } = fakeCompletion({ contentText: 'ok', toolCalls: [], raw: { fullText: 'ok' } });
    const p = createQvacProvider({ completion: fn as any, cancel: noopCancel, getModelId: () => 'm1' });
    await p.runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [] });
    expect(calls[0].generationParams).toBeUndefined();
  });

  it('sends the thinking cap as the SDK reasoning_budget', async () => {
    const { fn, calls } = fakeCompletion({ contentText: 'ok', toolCalls: [], raw: { fullText: 'ok' } });
    const p = createQvacProvider({ completion: fn as any, cancel: noopCancel, getModelId: () => 'm1', maxThinkingTokens: 128 });
    await p.runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [] });
    expect(calls[0].generationParams).toEqual({ reasoning_budget: 128 });
  });

  it("sends reasoning_budget 0 when a turn asks for thinking 'off'", async () => {
    const { fn, calls } = fakeCompletion({ contentText: 'ok', toolCalls: [], raw: { fullText: 'ok' } });
    const p = createQvacProvider({ completion: fn as any, cancel: noopCancel, getModelId: () => 'm1', maxThinkingTokens: 128 });
    await p.runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [], thinking: 'off' });
    expect(calls[0].generationParams).toEqual({ reasoning_budget: 0 });
  });

  it('uses the session key as kvCache when sessionCache is on, and deletes it at the end', async () => {
    const { fn, calls } = fakeCompletion({ contentText: 'ok', toolCalls: [], raw: { fullText: 'ok' } });
    const deleted: unknown[] = [];
    const on = createQvacProvider({ completion: fn as any, cancel: noopCancel, getModelId: () => 'm1', sessionCache: true, deleteCache: (async (p: unknown) => void deleted.push(p)) as any });
    const off = createQvacProvider({ completion: fn as any, cancel: noopCancel, getModelId: () => 'm1' });
    await on.runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [], sessionKey: 'run-1' });
    await off.runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [], sessionKey: 'run-1' });
    await on.endSession!('run-1');
    expect(calls[0].kvCache).toBe('run-1');
    expect(calls[1].kvCache).toBeUndefined();
    expect(deleted).toEqual([{ kvCacheKey: 'run-1' }]);
  });

  it('retries a turn without reasoning when the tool grammar rejects the inserted </think>', async () => {
    const calls: any[] = [];
    const fn = (params: any) => {
      calls.push(params);
      if (calls.length === 1) throw new Error('Unexpected empty grammar stack after accepting piece: </think> (248069)');
      return { requestId: 'req-2', events: (async function* () {})(), final: Promise.resolve({ contentText: 'ok', toolCalls: [], raw: { fullText: 'ok' } }) };
    };
    const p = createQvacProvider({ completion: fn as any, cancel: noopCancel, getModelId: () => 'm1', maxThinkingTokens: 128 });
    const out = await p.runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [] });
    expect(out.text).toBe('ok');
    expect(calls.map((c) => c.generationParams?.reasoning_budget)).toEqual([128, 0]);
    await expect(
      createQvacProvider({ completion: (() => { throw new Error('boom'); }) as any, cancel: noopCancel, getModelId: () => 'm1' })
        .runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [] }),
    ).rejects.toThrow('boom');
  });

  it('keeps the reasoning budget below the output cap', async () => {
    const { fn, calls } = fakeCompletion({ contentText: 'ok', toolCalls: [], raw: { fullText: 'ok' } });
    const p = createQvacProvider({ completion: fn as any, cancel: noopCancel, getModelId: () => 'm1', defaultMaxTokens: 512, maxThinkingTokens: 512 });
    await p.runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [] });
    expect(calls[0].generationParams).toEqual({ predict: 512, reasoning_budget: 256 });
  });

  it('forwards toolChoice only when tools are present', async () => {
    const tool = { name: 'get_balance', description: 'b', parameters: { type: 'object', properties: {} } };
    const { fn, calls } = fakeCompletion({ contentText: 'ok', toolCalls: [], raw: { fullText: 'ok' } });
    const p = createQvacProvider({ completion: fn as any, cancel: noopCancel, getModelId: () => 'm1' });
    await p.runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [tool as any], toolChoice: 'required' });
    await p.runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [], toolChoice: 'required' });
    expect(calls[0].generationParams).toEqual({ tool_choice: 'required' });
    expect(calls[1].generationParams).toBeUndefined();
  });

  it('returns toolErrors when the model emitted a tool call that did not parse', async () => {
    const toolErrors = [{ code: 'PARSE_ERROR', message: 'unterminated string', raw: '{"ticker":"HCK' }];
    const { fn } = fakeCompletion({ contentText: '', toolCalls: [], toolErrors, raw: { fullText: '<tool_call>{"ticker":"HCK' } });
    const p = createQvacProvider({ completion: fn as any, cancel: noopCancel, getModelId: () => 'm1' });
    const out = await p.runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [] });
    expect(out.toolCalls).toEqual([]);
    expect(out.toolErrors).toEqual(toolErrors);
  });

  it('returns a cancelled turn when the SDK rejects final on abort', async () => {
    const cancel = vi.fn(async () => {});
    const fn = () => ({
      requestId: 'req-a',
      events: (async function* () {})(),
      final: Promise.reject(Object.assign(new Error('cancelled'), { requestId: 'req-a', partial: {} })),
    });
    const ac = new AbortController();
    ac.abort();
    const p = createQvacProvider({ completion: fn as any, cancel: cancel as any, getModelId: () => 'm1' });
    const out = await p.runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [], signal: ac.signal });
    expect(cancel).toHaveBeenCalledWith({ requestId: 'req-a' });
    expect(out.inference?.status).toBe('cancelled');
    expect(out.toolCalls).toEqual([]);
  });

  it('derives token counts from the SDK generatedTokens stat', async () => {
    const { fn } = fakeCompletion({
      contentText: 'ok', toolCalls: [], raw: { fullText: 'ok' },
      stats: { promptTokens: 100, generatedTokens: 20, tokensPerSecond: 12, backendDevice: 'gpu' },
    });
    const p = createQvacProvider({ completion: fn as any, cancel: noopCancel, getModelId: () => 'm1' });
    const out = await p.runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [] });
    expect(out.inference).toMatchObject({ promptTokens: 100, totalTokens: 120, completionTokens: 20, backendDevice: 'gpu' });
  });

  it('streams visible content tokens to onToken', async () => {
    const { fn } = fakeCompletion(
      { contentText: 'Hi there', toolCalls: [], raw: { fullText: 'Hi there' } },
      [{ type: 'contentDelta', text: 'Hi ' }, { type: 'contentDelta', text: 'there' }],
    );
    const tokens: string[] = [];
    const p = createQvacProvider({ completion: fn as any, cancel: noopCancel, getModelId: () => 'm1' });
    await p.runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [], onToken: (t) => tokens.push(t) });
    expect(tokens).toEqual(['Hi ', 'there']);
  });
});

describe('createQvacProvider.cancel', () => {
  it('forwards the requestId to the SDK cancel', async () => {
    const cancel = vi.fn(async () => {});
    const { fn } = fakeCompletion({ contentText: 'ok', toolCalls: [], raw: { fullText: 'ok' } });
    const p = createQvacProvider({ completion: fn as any, cancel: cancel as any, getModelId: () => 'm1' });
    await p.cancel!('req-9');
    expect(cancel).toHaveBeenCalledWith({ requestId: 'req-9' });
  });
});
