/**
 * Skills tests — parse SKILL.md, select per query, compose system + tool
 * filter, and verify the engine honours allowedTools (progressive disclosure).
 */

import { describe, it, expect, vi } from 'vitest';
import { SkillRegistry, parseSkill, READ_REFERENCE_TOOL } from './registry.js';
import { createSkillReferenceToolSource } from './reference-source.js';
import { skillsFromBundle } from './bundle.js';
import { Engine } from '../engine.js';
import { ToolRegistry } from '../tools/registry.js';
import { InProcessToolSource } from '../tools/in-process.js';
import type { LLMProvider } from '../providers/types.js';
import type { ToolCall } from '../types.js';

// A real-spec SKILL.md: quoted multi-line description, nested metadata, no tools.
const BITREFILL_SKILL = `---
name: bitrefill
description: "Buy or browse Bitrefill — gift cards, mobile top-ups, and eSIMs. Triggers when the user mentions Bitrefill, gift cards, mobile top-up, or eSIM."
compatibility: "Detects host capabilities at runtime."
metadata:
  author: bitrefill
  version: "2.1.5"
---

# Bitrefill

Routes by capability. See the references for each path.`;

const PORTFOLIO_SKILL = `---
name: portfolio-manager
description: Rebalance the BTC, USDT and XAUT portfolio to target allocations.
tools: get_balance, place_order
triggers: rebalance, allocation, portfolio
---
You manage a Bitcoin L2 portfolio. Check balances first, then place orders to
hit the target allocation. Never exceed the user's risk band.`;

describe('parseSkill', () => {
  it('parses frontmatter + body', () => {
    const s = parseSkill(PORTFOLIO_SKILL);
    expect(s.name).toBe('portfolio-manager');
    expect(s.description).toMatch(/Rebalance/);
    expect(s.tools).toEqual(['get_balance', 'place_order']);
    expect(s.triggers).toEqual(['rebalance', 'allocation', 'portfolio']);
    expect(s.instructions).toMatch(/manage a Bitcoin L2 portfolio/);
  });
});

describe('SkillRegistry selection', () => {
  const reg = new SkillRegistry();
  reg.addMarkdown(PORTFOLIO_SKILL);
  reg.addMarkdown(`---
name: channel-manager
description: Open and manage Lightning channels.
triggers: channel, liquidity, lsp
---
Manage Lightning channels via LSPS1.`);

  it('routes a query to the right skill by trigger/description', () => {
    expect(reg.select('please rebalance my portfolio')?.name).toBe('portfolio-manager');
    expect(reg.select('open a new lightning channel')?.name).toBe('channel-manager');
  });

  it('returns null when nothing matches', () => {
    expect(reg.select('what is the weather today')).toBeNull();
  });

  it('composes the system prompt + exposes the skill tool list', () => {
    const skill = reg.select('rebalance my allocation')!;
    const { system, allowedTools } = reg.compose('You are KaleidoMind.', skill);
    expect(system).toMatch(/You are KaleidoMind\./);
    expect(system).toMatch(/Active skill: portfolio-manager/);
    expect(allowedTools).toEqual(['get_balance', 'place_order']);
  });
});

describe('SkillRegistry selection — trigger word boundaries', () => {
  // Regression: short triggers must NOT match inside longer words.
  // Bug observed in the CLI: a wallet skill with `usd` as a trigger was
  // picked for "what is the quote of usdt to btc" because the old
  // q.includes("usd") was true for "usdt", outranking the trading skill.
  const reg = new SkillRegistry();
  reg.addMarkdown(`---
name: wallet-fiat
description: Check the BTC price and convert fiat to sats. Fiat support: usd, eur, gbp.
triggers: price, eur, usd, gbp
---
Wallet — fiat conversion.`);
  reg.addMarkdown(`---
name: trading
description: Quote and execute swaps between BTC, USDT and XAUT on KaleidoSwap.
triggers: quote, swap, trade, usdt, xaut
---
Trading on the maker.`);

  it("doesn't fire the `usd` trigger inside `usdt`", () => {
    const sel = reg.select('what is the quote of usdt to btc')?.name;
    expect(sel).toBe('trading'); // not wallet-fiat
  });

  it('still fires the `usd` trigger when the user actually said `usd`', () => {
    const sel = reg.select('how many sats is 30 usd')?.name;
    expect(sel).toBe('wallet-fiat');
  });

  it("doesn't fire a short trigger inside a longer word — `cafe` not in `cafeteria`", () => {
    const r2 = new SkillRegistry();
    r2.addMarkdown(`---
name: merchants
description: Find merchants that accept Bitcoin.
triggers: cafe, restaurant, bar
---
Merchant finder.`);
    expect(r2.select('the cafeteria menu')).toBeNull(); // no match
    expect(r2.select('any bitcoin cafe nearby')?.name).toBe('merchants');
  });
});

describe('parseSkill — real Agent-Skills spec', () => {
  it('unquotes the description, captures metadata, tolerates no tools', () => {
    const s = parseSkill(BITREFILL_SKILL);
    expect(s.name).toBe('bitrefill');
    expect(s.description.startsWith('"')).toBe(false);
    expect(s.description).toMatch(/gift cards/);
    expect(s.tools).toBeUndefined();
    // nested metadata keys fold into the flat metadata map
    expect(s.metadata?.author).toBe('bitrefill');
    expect(s.metadata?.version).toBe('2.1.5');
    expect(s.metadata?.compatibility).toMatch(/host capabilities/);
  });

  it('selects on the long description embedding trigger phrases', () => {
    const reg = new SkillRegistry();
    reg.addMarkdown(BITREFILL_SKILL);
    expect(reg.select('can you buy me an amazon gift card')?.name).toBe('bitrefill');
    expect(reg.select('I want to buy an eSIM data plan')?.name).toBe('bitrefill');
  });
});

describe('progressive disclosure — references', () => {
  const refs = [
    { name: 'mcp.md', content: '# MCP\nUse the remote MCP at api.bitrefill.com/mcp.' },
    { name: 'cli.md', content: '# CLI\nGuest checkout via @bitrefill/cli.' },
  ];

  it('compose() advertises the reference files + keeps the reader tool reachable', () => {
    const reg = new SkillRegistry();
    reg.addMarkdown(
      `---\nname: bitrefill\ndescription: shop with bitcoin\ntools: buy_product\ntriggers: bitrefill\n---\nbody`,
      refs,
    );
    const skill = reg.get('bitrefill')!;
    const { system, allowedTools } = reg.compose('base', skill);
    expect(system).toMatch(/Reference files/);
    expect(system).toMatch(/mcp\.md, cli\.md/);
    expect(system).toMatch(READ_REFERENCE_TOOL);
    // scoped tools, plus the reference reader so refs stay readable
    expect(allowedTools).toEqual(['buy_product', READ_REFERENCE_TOOL]);
  });

  it('the reference tool source returns file contents and lists on miss', async () => {
    const reg = new SkillRegistry();
    reg.addMarkdown(`---\nname: bitrefill\ndescription: d\n---\nbody`, refs);
    const src = createSkillReferenceToolSource(reg);
    expect(src.has(READ_REFERENCE_TOOL)).toBe(true);

    const out = await src.execute(READ_REFERENCE_TOOL, { file: 'mcp.md' });
    expect(out).toMatch(/remote MCP/);

    // scoping by skill + path-prefixed filename both resolve
    const out2 = await src.execute(READ_REFERENCE_TOOL, { file: 'references/cli.md', skill: 'bitrefill' });
    expect(out2).toMatch(/Guest checkout/);

    await expect(src.execute(READ_REFERENCE_TOOL, { file: 'nope.md' })).rejects.toThrow(
      /not found.*bitrefill\/mcp\.md/,
    );
  });
});

describe('skillsFromBundle — RN-safe loading', () => {
  it('rehydrates skills (incl. references) from a v1 bundle', () => {
    const skills = skillsFromBundle({
      version: 1,
      skills: [
        {
          dir: 'bitrefill',
          markdown: '---\nname: bitrefill\ndescription: shop with bitcoin\ntriggers: bitrefill, gift card\n---\nbody',
          references: [{ name: 'mcp.md', content: '# MCP' }],
        },
      ],
    });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('bitrefill');
    expect(skills[0].references?.[0]?.name).toBe('mcp.md');
    expect(skills[0].dir).toBe('bitrefill');
    // and it's selectable through a registry built from the bundle
    expect(new SkillRegistry(skills).select('buy a gift card')?.name).toBe('bitrefill');
  });

  it('rejects a malformed bundle', () => {
    expect(() => skillsFromBundle({ version: 2 as 1, skills: [] })).toThrow(/valid v1/);
  });
});

describe('engine honours allowedTools (progressive disclosure)', () => {
  it('only exposes the skill’s tools to the model', async () => {
    const seenToolNames: string[][] = [];
    const provider: LLMProvider = {
      name: 'spy',
      async runTurn(input) {
        seenToolNames.push(input.tools.map((t) => t.name));
        return { text: 'done', rawContent: 'done', toolCalls: [] as ToolCall[] };
      },
    };
    const tools = new ToolRegistry([
      new InProcessToolSource('wallet', [
        { name: 'get_balance', description: '', parameters: {}, handler: async () => ({}) },
        { name: 'place_order', description: '', parameters: {}, handler: async () => ({}) },
        { name: 'open_channel', description: '', parameters: {}, handler: async () => ({}) },
        { name: 'delete_everything', description: '', parameters: {}, handler: async () => ({}) },
      ]),
    ]);
    const engine = new Engine({ provider, tools });

    await engine.runAgentic([{ role: 'user', content: 'rebalance' }], {
      allowedTools: ['get_balance', 'place_order'],
    });

    // The model only saw the two allowed tools — not open_channel / delete_everything.
    expect(seenToolNames[0].sort()).toEqual(['get_balance', 'place_order']);
  });
});
