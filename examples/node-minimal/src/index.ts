/**
 * The smallest useful @kaleidorg/mind agent:
 *   QVAC local model -> Engine -> one in-process tool, routed by one skill.
 *
 *   pnpm start                       # downloads Qwen3.5 4B (~2.7 GB) on first run
 *   pnpm start "price of bitcoin in EUR?"
 *   pnpm start:mock                  # no model: a scripted provider replays the turn
 */
import { Engine, InProcessToolSource, SkillRegistry, ToolRegistry, type LLMProvider } from '@kaleidorg/mind';
import { createQvacProvider } from '@kaleidorg/mind/qvac';
import { scriptedProvider } from '@kaleidorg/mind/testing';

const MOCK = process.argv.includes('--mock') || process.env.MOCK === '1';
const question = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ') || 'What is the bitcoin price in EUR?';

// 1. A tool: JSON Schema in, any JSON out. Handlers run in this process.
const tools = new ToolRegistry([
  new InProcessToolSource('demo', [
    {
      name: 'get_btc_price',
      description: 'Get the current BTC price in a fiat currency.',
      parameters: {
        type: 'object',
        properties: { fiat: { type: 'string', description: "ISO currency code, e.g. 'USD', 'EUR'" } },
        required: ['fiat'],
      },
      handler: async ({ fiat }) => {
        const code = String(fiat ?? 'USD').toUpperCase();
        return { fiat: code, price: code === 'EUR' ? 60_000 : 65_000, source: 'demo data' };
      },
    },
  ]),
]);

// 2. A skill: a SKILL.md playbook that scopes the model to the tools it needs.
const skills = new SkillRegistry().addMarkdown(`---
name: price-check
description: Answer questions about the bitcoin price in any fiat currency.
tools: get_btc_price
triggers: price, btc, bitcoin, worth
---
Call get_btc_price with the currency the user asked for (default USD).
Answer in one sentence using only the number the tool returned.`);

// 3. A provider: QVAC on-device inference, or a scripted stand-in.
async function createProvider(): Promise<{ provider: LLMProvider; dispose: () => Promise<void> }> {
  if (MOCK) {
    const provider = scriptedProvider([
      { tool: 'get_btc_price', args: { fiat: 'EUR' } },
      { text: 'Bitcoin is at 60,000 EUR (demo data).' },
    ]);
    return { provider, dispose: async () => {} };
  }
  const sdk = await import('@qvac/sdk');
  console.error('[loading Qwen3.5 4B — the first run downloads ~2.7 GB]');
  let lastPct = -1;
  const modelId = await sdk.loadModel({
    modelSrc: sdk.QWEN3_5_4B_MULTIMODAL_Q4_K_M,
    modelConfig: { ctx_size: 4096, tools: true },
    onProgress: (p: { percentage?: number }) => {
      const pct = Math.floor(p.percentage ?? 0);
      if (pct !== lastPct && pct % 10 === 0) console.error(`  download ${pct}%`);
      lastPct = pct;
    },
  });
  const provider = createQvacProvider({
    completion: sdk.completion,
    cancel: sdk.cancel,
    getModelId: () => modelId,
    defaultTemperature: 0.2,
    defaultMaxTokens: 512,
    maxThinkingTokens: 384,
  });
  return {
    provider,
    dispose: async () => {
      await sdk.unloadModel({ modelId });
      await sdk.close();
    },
  };
}

const { provider, dispose } = await createProvider();
try {
  const engine = new Engine({ provider, tools });
  const skill = skills.select(question);
  const { system, allowedTools } = skills.compose('You are a concise assistant. Use tools for facts.', skill);

  console.error(`> ${question}  [skill: ${skill?.name ?? 'none'}]`);
  const result = await engine.runAgentic(
    [
      { role: 'system', content: system },
      { role: 'user', content: question },
    ],
    {
      allowedTools,
      onToolCall: (call) => console.error(`  tool ${call.name} ${JSON.stringify(call.arguments)}`),
      onToolResult: (r) => console.error(`  result ${JSON.stringify(r.result)}`),
    },
  );
  console.log(result.text);
  const tps = result.inference.map((i) => i.tokensPerSecond).filter((n): n is number => typeof n === 'number');
  console.error(`[${result.turns} turn(s), ${result.latencyMs} ms${tps.length ? `, ~${Math.round(tps[0]!)} tok/s` : ''}]`);
} finally {
  await dispose();
}
