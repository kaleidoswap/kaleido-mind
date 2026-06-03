/**
 * Skills tests — parse SKILL.md, select per query, compose system + tool
 * filter, and verify the engine honours allowedTools (progressive disclosure).
 */

import { describe, it, expect, vi } from 'vitest';
import { SkillRegistry, parseSkill } from './registry.js';
import { Engine } from '../engine.js';
import { ToolRegistry } from '../tools/registry.js';
import { InProcessToolSource } from '../tools/in-process.js';
import type { LLMProvider } from '../providers/types.js';
import type { ToolCall } from '../types.js';

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
