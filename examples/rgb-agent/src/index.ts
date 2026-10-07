/**
 * RGB agent: a local QVAC model drives an RGB Lightning Node (RLN) through
 * kaleido-mcp — check RGB balances, create an RGB invoice, send an asset.
 *
 *   pnpm start                  # kaleido-mcp over stdio on signet + local model
 *   pnpm start:mock             # fake in-process RLN tools + local model (no node)
 *   pnpm start:offline          # fake tools + scripted model (no node, no download)
 *
 * Flags: --mock (fake RLN tools), --scripted (no model), --yes (auto-approve spends).
 * Env:   RECIPIENT_INVOICE  RGB invoice to pay in step 3 (real mode)
 *        MODEL              @qvac/sdk model constant (default: QWEN3_5_2B_MULTIMODAL_Q4_K_M)
 *        KALEIDO_NETWORK    passed to kaleido-mcp (default: signet)
 *        RLN_NODE_URL       your RLN node (default inside kaleido-mcp: http://localhost:3001)
 */
import { createInterface } from 'node:readline/promises';
import {
  Engine,
  SkillRegistry,
  ToolRegistry,
  confirmReadback,
  type ConfirmDecision,
  type LLMProvider,
} from '@kaleidorg/mind';
import { loadSkillsDir, packagedSkillsDir } from '@kaleidorg/mind/skills';
import { scriptedProvider } from '@kaleidorg/mind/testing';
import { createTools, loadQvacProvider } from './setup.js';

const flag = (name: string) => process.argv.includes(`--${name}`);
const MOCK = flag('mock') || process.env.MOCK === '1';
const SCRIPTED = flag('scripted');
const AUTO_YES = flag('yes');

const RLN_TOOLS = ['rln_list_assets', 'rln_get_asset_balance', 'rln_refresh_transfers', 'rln_create_rgb_invoice', 'rln_send_asset'];

async function createProvider(): Promise<{ provider: LLMProvider; dispose: () => Promise<void> }> {
  if (SCRIPTED) {
    return {
      provider: scriptedProvider([
        { tool: 'rln_list_assets' },
        { text: 'You hold 1,000 USDT and 2 XAUT.' },
        { tool: 'rln_create_rgb_invoice', args: { asset: 'USDT', amount: 10 } },
        { text: 'Here is your RGB invoice for 10 USDT.' },
        { tool: 'rln_send_asset', args: { asset: 'USDT', amount: 5, to: recipient() } },
        { text: 'Sent 5 USDT.' },
      ]),
      dispose: async () => {},
    };
  }
  return loadQvacProvider(process.env.MODEL);
}

function recipient(): string {
  return process.env.RECIPIENT_INVOICE ?? (MOCK ? 'rgb:~/~/~/sig/any/5/utxob:mock-recipient-invoice' : '');
}

// ── Human-in-the-loop gate: every spend is read back and needs a yes ────────
async function confirm(call: { name: string; arguments: Record<string, unknown> }): Promise<ConfirmDecision> {
  const line = confirmReadback(call) ?? `Run ${call.name}?`;
  if (AUTO_YES) {
    console.error(`  ${line} -> yes (--yes)`);
    return { approved: true };
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`  ${line} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim()) ? { approved: true } : { approved: false, reason: 'user declined' };
}

const tools = await createTools({ mock: MOCK, allow: RLN_TOOLS });
const { provider, dispose } = await createProvider();
try {
  // All bundled skills. composeSkill() skips the ones whose tools this registry
  // lacks (e.g. spark-wallet without Spark tools) before the model runs.
  const skills = new SkillRegistry(loadSkillsDir(packagedSkillsDir()));
  const engine = new Engine({ provider, tools: new ToolRegistry([tools.source]), compressToolOutput: true });
  const base = 'You operate the user\'s RGB Lightning Node. Use tools for every value; never invent ids or invoices. Copy invoices exactly.';

  const steps = [
    'Which RGB assets do I hold, and what are the balances?',
    'Create an RGB invoice so I can receive 10 USDT.',
    ...(recipient() ? [`Send 5 USDT to this RGB invoice: ${recipient()}`] : []),
  ];
  if (!recipient()) console.error('[skipping the send step: set RECIPIENT_INVOICE to an RGB invoice to pay]');

  for (const question of steps) {
    const { skill, system, allowedTools } = await engine.composeSkill(skills, question, base);
    console.error(`\n> ${question}  [skill: ${skill?.name ?? 'none'}]`);
    const result = await engine.runAgentic(
      [
        { role: 'system', content: system },
        { role: 'user', content: question },
      ],
      {
        allowedTools,
        onConfirm: confirm,
        onToolCall: (c) => console.error(`  tool ${c.name} ${JSON.stringify(c.arguments)}`),
      },
    );
    console.log(result.text);
  }
} finally {
  await dispose();
  await tools.close();
}
