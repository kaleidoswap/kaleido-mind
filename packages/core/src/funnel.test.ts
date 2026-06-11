import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from './tools/registry.js';
import { InProcessToolSource } from './tools/in-process.js';
import type { LLMProvider, TurnInput, TurnOutput } from './providers/types.js';
import { Funnel, DEFAULT_WALLET_SYSTEM } from './funnel.js';
import { parseSkill } from './skills/registry.js';

// ── Fixtures ──────────────────────────────────────────────────────────

/** Stub contract tools across all three tiers + ambient memory/RAG. */
function stubTools(spy?: { send?: (a: any) => void }) {
  const wallet = new InProcessToolSource('wallet', [
    { name: 'get_balances', description: 'balances', parameters: {}, handler: async () => ({ total_sats: 4000, layers: [{ layer: 'spark' }, { layer: 'rln' }] }) },
    { name: 'get_price', description: 'price', parameters: {}, handler: async () => ({ price_usd: 100000 }) },
    { name: 'resolve_contact', description: '', parameters: {}, handler: async ({ name }) => ({ name, ln_address: `${name}@kaleidoswap.com` }) },
    { name: 'fiat_to_sats', description: '', parameters: {}, handler: async ({ amount }) => ({ sats: Math.round(Number(amount) * 1000) }) },
    { name: 'send_payment', description: '', parameters: {}, requiresConfirmation: true, handler: async (a) => { spy?.send?.(a); return { status: 'SUCCESS' }; } },
    { name: 'list_channels', description: 'channels', parameters: {}, handler: async () => ({ channels: [] }) },
  ]);
  const ambient = new InProcessToolSource('ambient', [
    { name: 'remember', description: '', parameters: {}, handler: async () => ({ ok: true }) },
    { name: 'recall', description: '', parameters: {}, handler: async () => ({ items: [] }) },
    { name: 'search_knowledge', description: '', parameters: {}, handler: async () => ({ chunks: [] }) },
  ]);
  return new ToolRegistry([wallet, ambient]);
}

/** Provider that replays scripted turns and records every TurnInput. */
function scriptedProvider(turns: Array<Partial<TurnOutput>>): LLMProvider & { inputs: TurnInput[] } {
  const inputs: TurnInput[] = [];
  let i = 0;
  return {
    name: 'scripted',
    inputs,
    async runTurn(input: TurnInput): Promise<TurnOutput> {
      // Snapshot — the Engine mutates its messages array across turns.
      inputs.push({ ...input, messages: [...input.messages] });
      const t = turns[Math.min(i++, turns.length - 1)] ?? {};
      return { text: t.text ?? '', rawContent: t.rawContent ?? t.text ?? '', toolCalls: t.toolCalls ?? [] };
    },
  };
}

const TEST_SKILL = parseSkill(
  [
    '---',
    'name: channels',
    'description: Inspect Lightning channels.',
    'triggers: channels, channel, liquidity',
    'tools: list_channels',
    '---',
    'When asked about channels, call list_channels and summarise.',
  ].join('\n'),
);

// ── T0: fast-path ─────────────────────────────────────────────────────

describe('Funnel — T0 fast-path', () => {
  it('answers balance with zero inferences and returns the card data', async () => {
    const provider = scriptedProvider([]);
    const funnel = new Funnel({ provider, tools: stubTools() });

    const res = await funnel.runTurn("what's my balance?");

    expect(res.tier).toBe('fast');
    expect(res.intent).toBe('balance');
    expect(res.text).toContain('4,000 sats');
    expect(res.data).toMatchObject({ total_sats: 4000 });
    expect(provider.inputs).toHaveLength(0); // no LLM
  });
});

// ── T2: recipes ───────────────────────────────────────────────────────

describe('Funnel — T2 recipes', () => {
  it('runs a confident payment deterministically, confirm-gated', async () => {
    const sent: any[] = [];
    const provider = scriptedProvider([]);
    const onConfirm = vi.fn(async () => ({ approved: true }));
    const onStep = vi.fn();
    const funnel = new Funnel({ provider, tools: stubTools({ send: (a) => sent.push(a) }) });

    const res = await funnel.runTurn('pay bob 3 eur', { onConfirm, onStep });

    expect(res.tier).toBe('recipe');
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(sent[0]).toEqual({ to: 'bob@kaleidoswap.com', amount_sats: 3000 });
    expect(onStep).toHaveBeenCalled();
    expect(provider.inputs).toHaveLength(0); // deterministic extraction
  });

  it('fails closed: a recipe spend with no onConfirm sends nothing', async () => {
    const sent: any[] = [];
    const funnel = new Funnel({ provider: scriptedProvider([]), tools: stubTools({ send: (a) => sent.push(a) }) });

    const res = await funnel.runTurn('pay bob 3 eur');

    expect(res.tier).toBe('recipe');
    expect(sent).toHaveLength(0);
  });
});

describe('Funnel — partial tool surfaces fall through to agentic', () => {
  it('skips T0 and T2 when the registry lacks their tools', async () => {
    // A host (e.g. desktop MCP) that implements none of the contract helpers.
    const bare = new ToolRegistry([
      new InProcessToolSource('other', [
        { name: 'unrelated_tool', description: '', parameters: {}, handler: async () => ({}) },
      ]),
    ]);
    const provider = scriptedProvider([{ text: 'answered by the model' }]);
    const funnel = new Funnel({ provider, tools: bare });

    const fast = await funnel.runTurn("what's my balance?");
    expect(fast.tier).toBe('agentic'); // no get_balances → no T0

    const pay = await funnel.runTurn('pay bob 3 eur');
    expect(pay.tier).toBe('agentic'); // no send_payment → no T2
  });
});

// ── T1: agentic ───────────────────────────────────────────────────────

describe('Funnel — T1 agentic', () => {
  it('routes unmatched queries to the engine and returns tool calls', async () => {
    const provider = scriptedProvider([
      { toolCalls: [{ name: 'get_price', arguments: {} }] },
      { text: 'BTC is at $100,000.' },
    ]);
    const onToolCall = vi.fn();
    const funnel = new Funnel({ provider, tools: stubTools() });

    const res = await funnel.runTurn('should I buy more sats this week?', { onToolCall });

    expect(res.tier).toBe('agentic');
    expect(res.text).toBe('BTC is at $100,000.');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls?.[0]).toMatchObject({ name: 'get_price', result: { price_usd: 100000 } });
    // requiresConfirmation enrichment is async (getDef) — let it flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(onToolCall).toHaveBeenCalledWith({ name: 'get_price', arguments: {} }, { requiresConfirmation: false });
  });

  it('appends the persona and trims history per settings', async () => {
    const provider = scriptedProvider([{ text: 'ok' }]);
    const funnel = new Funnel({
      provider,
      tools: stubTools(),
      getSettings: () => ({ persona: 'Speak like a pirate.', historyLength: 2 }),
    });

    const history = Array.from({ length: 6 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }));
    await funnel.runTurn('tell me something', { history });

    const messages = provider.inputs[0].messages;
    expect(messages[0].content).toContain(DEFAULT_WALLET_SYSTEM);
    expect(messages[0].content).toContain('Speak like a pirate.');
    // system + 2 kept history + the new user message
    expect(messages).toHaveLength(4);
    expect(messages[1].content).toBe('m4');
    expect(messages[2].content).toBe('m5');
  });

  it('scopes tools to the matched skill plus ambient tools', async () => {
    const provider = scriptedProvider([{ text: 'ok' }]);
    const funnel = new Funnel({ provider, tools: stubTools(), skills: [TEST_SKILL] });

    await funnel.runTurn('how are my channels doing?');

    const names = provider.inputs[0].tools.map((t) => t.name);
    expect(names).toContain('list_channels');
    expect(names).toContain('remember');
    expect(names).toContain('search_knowledge');
    expect(names).not.toContain('send_payment'); // narrowed out by the skill
  });

  it('hides ambient tools when their toggles are off (no skill matched)', async () => {
    const provider = scriptedProvider([{ text: 'ok' }]);
    const funnel = new Funnel({
      provider,
      tools: stubTools(),
      getSettings: () => ({ memoryEnabled: false, ragEnabled: false }),
    });

    await funnel.runTurn('tell me something interesting');

    const names = provider.inputs[0].tools.map((t) => t.name);
    expect(names).not.toContain('remember');
    expect(names).not.toContain('recall');
    expect(names).not.toContain('search_knowledge');
    expect(names).toContain('get_balances'); // everything else stays
  });

  it('listSkills honors disabledSkills and tracks settings changes', () => {
    let disabled: string[] = [];
    const funnel = new Funnel({
      provider: scriptedProvider([]),
      tools: stubTools(),
      skills: [TEST_SKILL],
      getSettings: () => ({ disabledSkills: disabled }),
    });

    expect(funnel.listSkills().map((s) => s.name)).toEqual(['channels']);
    disabled = ['channels'];
    expect(funnel.listSkills()).toHaveLength(0);
  });
});
