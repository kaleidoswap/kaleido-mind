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
 *        OPENAI_BASE_URL    use an OpenAI-compatible server instead of QVAC (with OPENAI_MODEL, OPENAI_API_KEY)
 *        KALEIDO_NETWORK    passed to kaleido-mcp (default: signet)
 *        RLN_NODE_URL       your RLN node (default inside kaleido-mcp: http://localhost:3001)
 */
import { createInterface } from 'node:readline/promises';
import { confirmReadback, type ConfirmDecision, type LLMProvider } from '@kaleidorg/mind';
import { scriptedProvider } from '@kaleidorg/mind/testing';
import { AGENT_TOOLS, createFunnel, createTools, loadProvider } from './setup.js';

const flag = (name: string) => process.argv.includes(`--${name}`);
const MOCK = flag('mock') || process.env.MOCK === '1';
const SCRIPTED = flag('scripted');
const AUTO_YES = flag('yes');

async function createProvider(): Promise<{ provider: LLMProvider; dispose: () => Promise<void> }> {
  if (SCRIPTED) {
    return {
      // The asset list is answered on the fast path, without the model.
      provider: scriptedProvider([
        { tool: 'rln_create_rgb_invoice', args: { asset: 'USDT', amount: 10 } },
        { text: 'Here is your RGB invoice for 10 USDT.' },
        { tool: 'rln_send_asset', args: { asset: 'USDT', amount: 5, to: recipient() } },
        { text: 'Sent 5 USDT.' },
      ]),
      dispose: async () => {},
    };
  }
  return loadProvider();
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
  // No terminal to ask on (piped or detached stdin): decline instead of waiting forever.
  if (!process.stdin.isTTY) {
    console.error(`  ${line} -> no (stdin is not a terminal; run interactively or pass --yes on the fake node)`);
    return { approved: false, reason: 'no terminal to confirm on' };
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`  ${line} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim()) ? { approved: true } : { approved: false, reason: 'user declined' };
}

// Expose exactly what the RGB node and trading skills name (their
// requires-tools too), so a skill is never dropped for a missing tool.
const tools = await createTools({ mock: MOCK, allow: AGENT_TOOLS });
const { provider, dispose } = await createProvider();
try {
  const funnel = createFunnel(provider, tools.source);

  const steps = [
    'Which RGB assets do I hold, and what are the balances?',
    'Create an RGB invoice so I can receive 10 USDT.',
    ...(recipient() ? [`Send 5 USDT to this RGB invoice: ${recipient()}`] : []),
  ];
  if (!recipient()) console.error('[skipping the send step: set RECIPIENT_INVOICE to an RGB invoice to pay]');

  for (const question of steps) {
    console.error(`\n> ${question}`);
    const result = await funnel.runTurn(question, {
      onConfirm: confirm,
      onToolCall: (c) => console.error(`  tool ${c.name} ${JSON.stringify(c.arguments)}`),
      onStep: (name) => console.error(`  step ${name}`),
    });
    console.error(`  [${result.tier}${result.route ? `/${result.route}` : ''}]`);
    console.log(result.text);
  }
} finally {
  await dispose();
  await tools.close();
}
