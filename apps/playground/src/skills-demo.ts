/**
 * Skills demo — the brain enters a skill, which scopes its tools + playbook.
 *
 *   pnpm --filter @kaleidorg/mind-playground exec tsx src/skills-demo.ts "rebalance my portfolio to mostly BTC"
 *   ... "what's my balance?"        → wallet-assistant skill
 *   ... "open a lightning channel"  → channel-manager skill
 *
 * Shows: query → SkillRegistry.select → compose(system + allowedTools) →
 * engine runs scoped to that skill's tools only (progressive disclosure). The
 * full toolset has 7 tools; each skill exposes a curated 2–3.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  Engine,
  ToolRegistry,
  InProcessToolSource,
  SkillRegistry,
  type LLMProvider,
  type InProcessTool,
} from '@kaleidorg/mind';

const MODEL_PATH =
  process.env.QVAC_MODEL_PATH || join(homedir(), '.kaleido', 'models', 'Qwen3-0.6B-Q4_K_M.gguf');

// Full tool surface (mock data) — far more than any one task needs.
const allTools: InProcessTool[] = [
  { name: 'get_balance', description: 'Get wallet BTC balance in sats.', parameters: { type: 'object', properties: {} }, handler: async () => ({ btc_sats: 4_200_000, usdt: 850, xaut: 0.4 }) },
  { name: 'get_address', description: 'Get a receive address.', parameters: { type: 'object', properties: {} }, handler: async () => ({ address: 'bc1qdemo' }) },
  { name: 'list_transactions', description: 'List recent transactions.', parameters: { type: 'object', properties: {} }, handler: async () => ({ txs: [{ amt: 5000, dir: 'in' }] }) },
  { name: 'pay_invoice', description: 'Pay a Lightning invoice/address.', parameters: { type: 'object', properties: { invoice_or_address: { type: 'string' }, amount_sats: { type: 'number' } }, required: ['invoice_or_address'] }, requiresConfirmation: true, handler: async (a: any) => ({ paid: true, to: a.invoice_or_address }) },
  { name: 'get_quote', description: 'Get a swap quote between assets.', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, amount: { type: 'number' } } }, handler: async (a: any) => ({ from: a.from, to: a.to, rate: 73000, out: 0.0137 }) },
  { name: 'place_order', description: 'Place a swap order to rebalance.', parameters: { type: 'object', properties: { pair: { type: 'string' }, side: { type: 'string' }, amount: { type: 'number' } } }, requiresConfirmation: true, handler: async (a: any) => ({ order_id: 'ord_demo', ...a }) },
  { name: 'open_channel', description: 'Open a Lightning channel via LSPS1.', parameters: { type: 'object', properties: { capacity_sats: { type: 'number' } } }, requiresConfirmation: true, handler: async (a: any) => ({ channel_id: 'chan_demo', ...a }) },
];

const SKILLS = [
  `---
name: wallet-assistant
description: Everyday wallet actions — check balance, get an address, list transactions, pay invoices.
tools: get_balance, get_address, list_transactions, pay_invoice
triggers: balance, address, pay, send, receive, transactions, invoice
---
Help with everyday wallet tasks. Check balances before paying. Confirm payments.`,
  `---
name: portfolio-manager
description: Rebalance the BTC / USDT / XAUT portfolio to target allocations.
tools: get_balance, get_quote, place_order
triggers: rebalance, allocation, portfolio, target, swap, buy, sell
---
Rebalance toward the target allocation. Always check the balance first, get a
quote, then place the order. Never exceed the user's stated risk.`,
  `---
name: channel-manager
description: Open and manage Lightning channels and inbound liquidity.
tools: open_channel, get_balance
triggers: channel, liquidity, lsp, inbound, capacity
---
Manage Lightning channels via LSPS1. Check the balance can cover the channel.`,
];

async function main() {
  const query = process.argv.slice(2).join(' ') || 'rebalance my portfolio toward more BTC';
  const sdk: any = await import('@qvac/sdk');

  const skills = new SkillRegistry();
  for (const md of SKILLS) skills.addMarkdown(md);

  const skill = skills.select(query);
  const BASE = 'You are KaleidoMind, a Bitcoin & Lightning agent. Use tools; never invent data.';
  const { system, allowedTools } = skills.compose(BASE, skill);

  console.log(`\n🧑 ${query}`);
  console.log(`\x1b[35m🎯 skill: ${skill?.name ?? '(none — full toolset)'} → exposing ${allowedTools?.length ?? allTools.length}/${allTools.length} tools: ${(allowedTools ?? allTools.map((t) => t.name)).join(', ')}\x1b[0m\n`);

  console.error(`\x1b[2m[loading ${MODEL_PATH}]\x1b[0m`);
  const modelId: string = await sdk.loadModel({ modelSrc: MODEL_PATH, modelType: 'llm', modelConfig: { ctx_size: 8192, tools: true } });

  const provider: LLMProvider = {
    name: 'qvac',
    async runTurn(input) {
      const history = input.system ? [{ role: 'system', content: input.system }, ...input.messages] : input.messages;
      const run: any = sdk.completion({ modelId, history, stream: true, tools: input.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) });
      let s = '';
      for await (const ev of run.events) if (ev?.type === 'contentDelta') { s += ev.text; input.onToken?.(ev.text); }
      const final = await run.final;
      const raw = final?.contentText || s || '';
      return { text: raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim(), rawContent: final?.raw?.fullText ?? raw, toolCalls: (final?.toolCalls || []).map((c: any, i: number) => ({ id: c.id ?? `c${i}`, name: c.name, arguments: c.arguments ?? {} })), requestId: run?.requestId };
    },
  };

  const engine = new Engine({ provider, tools: new ToolRegistry([new InProcessToolSource('wallet', allTools)]) });

  const res = await engine.runAgentic([{ role: 'system', content: system }, { role: 'user', content: query }], {
    allowedTools,
    onToolCall: (c) => console.log(`\n\x1b[36m   🔧 ${c.name}(${JSON.stringify(c.arguments).slice(0, 70)})\x1b[0m`),
    onConfirm: async (c) => { console.log(`\x1b[33m   ⚠️  approving ${c.name} (demo)\x1b[0m`); return { approved: true }; },
  });

  console.log(`\n\n🤖 ${res.text}`);
  console.log(`\x1b[2m\n[skill: ${skill?.name ?? 'none'} · ${res.turns} turns · tools: ${res.toolCalls.map((c) => c.name).join(', ') || 'none'}]\x1b[0m`);

  await sdk.unloadModel({ modelId });
  if (sdk.close) await sdk.close();
}

main().catch((e) => { console.error('skills-demo error:', e); process.exit(1); });
