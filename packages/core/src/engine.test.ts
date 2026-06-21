/**
 * Engine + tool-calling tests.
 *
 * These exercise the full agentic loop deterministically — no model, no
 * device — using a scripted mock provider and mock tool sources. This is the
 * fastest way to verify tools are selected, executed, fed back, and gated by
 * confirmation, exactly as they would be with a real QVAC model.
 *
 *   pnpm --filter @kaleidorg/mind test
 */

import { describe, it, expect, vi } from 'vitest';
import { Engine } from './engine.js';
import { ToolRegistry } from './tools/registry.js';
import { InProcessToolSource } from './tools/in-process.js';
import type { LLMProvider, TurnInput, TurnOutput } from './providers/types.js';
import type { ToolCall } from './types.js';

/**
 * A scripted provider: each entry in `script` is one turn's output. When it
 * returns tool calls, the engine executes them and calls the provider again
 * for the next scripted turn.
 */
function scriptedProvider(script: Array<{ text: string; toolCalls?: ToolCall[] }>): LLMProvider {
  let turn = 0;
  return {
    name: 'scripted',
    async runTurn(input: TurnInput): Promise<TurnOutput> {
      const step = script[Math.min(turn, script.length - 1)];
      turn += 1;
      // stream the text so onToken paths are exercised
      input.onToken?.(step.text);
      return {
        text: step.text,
        rawContent: step.text,
        toolCalls: step.toolCalls ?? [],
        requestId: `req-${turn}`,
      };
    },
  };
}

const balanceTool = {
  name: 'get_balance',
  description: 'Get the wallet balance in sats',
  parameters: {},
  handler: vi.fn(async () => ({ sats: 50_000 })),
};

const payTool = {
  name: 'pay_invoice',
  description: 'Pay a Lightning invoice',
  parameters: {},
  requiresConfirmation: true,
  handler: vi.fn(async (args: Record<string, unknown>) => ({ paid: true, to: args.invoice })),
};

function freshTools() {
  balanceTool.handler.mockClear();
  payTool.handler.mockClear();
  return new ToolRegistry([new InProcessToolSource('wallet', [balanceTool, payTool])]);
}

describe('Engine agentic loop', () => {
  it('calls a read tool, feeds the result back, and returns a final answer', async () => {
    const engine = new Engine({
      provider: scriptedProvider([
        { text: '', toolCalls: [{ name: 'get_balance', arguments: {} }] }, // turn 1: call tool
        { text: 'You have 50,000 sats.' }, // turn 2: final answer (sees the result)
      ]),
      tools: freshTools(),
    });

    const res = await engine.runAgentic([{ role: 'user', content: "what's my balance?" }]);

    expect(balanceTool.handler).toHaveBeenCalledTimes(1);
    expect(res.text).toBe('You have 50,000 sats.');
    expect(res.turns).toBe(2);
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].result).toEqual({ sats: 50_000 });
  });

  it('pauses money tools for confirmation and executes on approval', async () => {
    const onConfirm = vi.fn(async () => ({ approved: true }));
    const engine = new Engine({
      provider: scriptedProvider([
        { text: '', toolCalls: [{ name: 'pay_invoice', arguments: { invoice: 'lnbc1' } }] },
        { text: 'Sent ✅' },
      ]),
      tools: freshTools(),
    });

    const res = await engine.runAgentic([{ role: 'user', content: 'pay lnbc1' }], { onConfirm });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(payTool.handler).toHaveBeenCalledTimes(1);
    expect(res.text).toBe('Sent ✅');
    expect(res.toolCalls[0].result).toEqual({ paid: true, to: 'lnbc1' });
  });

  it('does NOT execute a money tool when the user declines', async () => {
    const onConfirm = vi.fn(async () => ({ approved: false, reason: 'cancelled' }));
    const engine = new Engine({
      provider: scriptedProvider([
        { text: '', toolCalls: [{ name: 'pay_invoice', arguments: { invoice: 'lnbc1' } }] },
        { text: 'Okay, cancelled.' },
      ]),
      tools: freshTools(),
    });

    const res = await engine.runAgentic([{ role: 'user', content: 'pay lnbc1' }], { onConfirm });

    expect(payTool.handler).not.toHaveBeenCalled();
    expect(res.toolCalls[0].result).toMatchObject({ declined: true, reason: 'cancelled' });
    expect(res.text).toBe('Okay, cancelled.');
  });

  it('chains multiple tool calls across turns', async () => {
    const engine = new Engine({
      provider: scriptedProvider([
        { text: '', toolCalls: [{ name: 'get_balance', arguments: {} }] },
        { text: '', toolCalls: [{ name: 'pay_invoice', arguments: { invoice: 'lnbc2' } }] },
        { text: 'Checked balance, then paid.' },
      ]),
      tools: freshTools(),
    });

    const res = await engine.runAgentic([{ role: 'user', content: 'check then pay' }], {
      onConfirm: async () => ({ approved: true }),
    });

    expect(balanceTool.handler).toHaveBeenCalledTimes(1);
    expect(payTool.handler).toHaveBeenCalledTimes(1);
    expect(res.turns).toBe(3);
    expect(res.toolCalls.map((c) => c.name)).toEqual(['get_balance', 'pay_invoice']);
  });

  it('stops at maxTurns if the model never stops calling tools', async () => {
    const engine = new Engine({
      provider: scriptedProvider([
        { text: 'loop', toolCalls: [{ name: 'get_balance', arguments: {} }] }, // always calls a tool
      ]),
      tools: freshTools(),
      defaultMaxTurns: 3,
    });

    const res = await engine.runAgentic([{ role: 'user', content: 'go' }]);

    expect(res.turns).toBe(3);
    expect(balanceTool.handler).toHaveBeenCalledTimes(3);
  });

  it('crushes verbose tool output in history but keeps the raw result for callbacks', async () => {
    const bulky = {
      name: 'list_merchants',
      description: 'returns many rows',
      parameters: {},
      handler: vi.fn(async () => ({
        results: Array.from({ length: 50 }, (_, i) => ({
          name: `Shop ${i}`,
          blurb: 'Accepts Bitcoin and Lightning, open daily, friendly staff and good wifi.',
          amount_sats: 1000 + i,
        })),
      })),
    };
    const onToolResult = vi.fn();
    const engine = new Engine({
      provider: scriptedProvider([
        { text: '', toolCalls: [{ name: 'list_merchants', arguments: {} }] },
        { text: 'Found some merchants.' },
      ]),
      tools: new ToolRegistry([new InProcessToolSource('m', [bulky])]),
      compressToolOutput: { maxArrayItems: 6 },
    });

    const res = await engine.runAgentic([{ role: 'user', content: 'find cafes' }], { onToolResult });

    // The history frame the model sees is crushed (elision marker present)...
    const toolFrame = res.messages.find((m) => m.role === 'tool');
    expect(toolFrame?.content).toContain('__elided__');
    // ...but amounts survive and the callback/result still carry the full data.
    expect(toolFrame?.content).toContain('amount_sats');
    expect(onToolResult.mock.calls[0][0].result).toEqual(await bulky.handler.mock.results[0].value);
    expect((res.toolCalls[0].result as { results: unknown[] }).results).toHaveLength(50);
  });

  it('surfaces a tool error as a result instead of throwing', async () => {
    const boom = {
      name: 'boom',
      description: 'throws',
      parameters: {},
      handler: vi.fn(async () => {
        throw new Error('kaboom');
      }),
    };
    const engine = new Engine({
      provider: scriptedProvider([
        { text: '', toolCalls: [{ name: 'boom', arguments: {} }] },
        { text: 'handled the error' },
      ]),
      tools: new ToolRegistry([new InProcessToolSource('x', [boom])]),
    });

    const res = await engine.runAgentic([{ role: 'user', content: 'go' }]);
    expect(res.toolCalls[0].result).toMatchObject({ error: 'kaboom' });
    expect(res.text).toBe('handled the error');
  });
});

describe('ToolRegistry', () => {
  it('merges tools from multiple sources and routes calls to the owner', async () => {
    const a = new InProcessToolSource('a', [
      { name: 'one', description: '', parameters: {}, handler: async () => 'from-a' },
    ]);
    const b = new InProcessToolSource('b', [
      { name: 'two', description: '', parameters: {}, handler: async () => 'from-b' },
    ]);
    const reg = new ToolRegistry([a, b]);

    const tools = await reg.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['one', 'two']);
    expect(await reg.execute('one', {})).toBe('from-a');
    expect(await reg.execute('two', {})).toBe('from-b');
  });

  it('first source wins on a name clash', async () => {
    const a = new InProcessToolSource('a', [
      { name: 'dup', description: 'A', parameters: {}, handler: async () => 'a' },
    ]);
    const b = new InProcessToolSource('b', [
      { name: 'dup', description: 'B', parameters: {}, handler: async () => 'b' },
    ]);
    const reg = new ToolRegistry([a, b]);
    const tools = await reg.listTools();
    expect(tools).toHaveLength(1);
    expect(await reg.execute('dup', {})).toBe('a');
  });
});
