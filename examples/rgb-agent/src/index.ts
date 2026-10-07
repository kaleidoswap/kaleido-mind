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
 *        KALEIDO_NETWORK    passed to kaleido-mcp (default: signet)
 *        RLN_NODE_URL       your RLN node (default inside kaleido-mcp: http://localhost:3001)
 */
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import {
  Engine,
  SkillRegistry,
  bindWalletTools,
  ToolRegistry,
  confirmReadback,
  type ConfirmDecision,
  type LLMProvider,
  type ToolSource,
} from '@kaleidorg/mind';
import { McpToolSource } from '@kaleidorg/mind/mcp';
import { loadSkillFromDir, packagedSkillsDir } from '@kaleidorg/mind/skills';
import { createQvacProvider } from '@kaleidorg/mind/qvac';
import { MockWallet, scriptedProvider } from '@kaleidorg/mind/testing';

const flag = (name: string) => process.argv.includes(`--${name}`);
const MOCK = flag('mock') || process.env.MOCK === '1';
const SCRIPTED = flag('scripted');
const AUTO_YES = flag('yes');

const RLN_TOOLS = ['rln_list_assets', 'rln_get_asset_balance', 'rln_refresh_transfers', 'rln_create_rgb_invoice', 'rln_send_asset'];

// ── Tools: kaleido-mcp over stdio, or an in-process fake node ───────────────
async function createTools(): Promise<{ source: ToolSource; close: () => Promise<void> }> {
  if (MOCK) {
    const wallet = new MockWallet({ assets: { USDT: 1_000, XAUT: 2 } });
    const asset = (ref: unknown) => wallet.rgbAssets.find((a) => a.asset_id === ref || a.ticker === String(ref).toUpperCase());
    // MockWallet speaks the wallet-contract schema; add the reads kaleido-mcp also has.
    const source = bindWalletTools(
      {
        ...wallet.handlers(),
        rln_get_asset_balance: async ({ asset_id }) => {
          const a = asset(asset_id);
          if (!a) throw new Error(`Unknown asset ${String(asset_id)}`);
          const amount = wallet.assets[a.ticker] ?? 0;
          return { asset_id: a.asset_id, ticker: a.ticker, settled: amount, spendable: amount };
        },
        rln_refresh_transfers: async () => ({ refreshed: true }),
        rln_create_rgb_invoice: async ({ asset: ref, amount }) => ({
          invoice: `rgb:~/~/~/sig/${asset(ref)?.asset_id ?? 'any'}/${String(amount ?? '')}/utxob:mock-${Date.now().toString(36)}`,
          amount,
        }),
      },
      { layers: ['rln'], includeCore: false, allowMissing: true, id: 'mock-rln' },
    );
    return { source, close: async () => {} };
  }
  const mcp = new McpToolSource({
    id: 'kaleido',
    transport: {
      kind: 'stdio',
      command: 'npx',
      args: ['-y', 'kaleido-mcp'],
      env: { ...(process.env as Record<string, string>), KALEIDO_NETWORK: process.env.KALEIDO_NETWORK ?? 'signet' },
    },
    allow: RLN_TOOLS,
  });
  await mcp.connect();
  return { source: mcp, close: () => mcp.close() };
}

// ── Model: QVAC on-device, or a scripted stand-in for CI ─────────────────────
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
  const sdk = await import('@qvac/sdk');
  console.error('[loading Qwen3.5 4B — the first run downloads ~2.7 GB]');
  const modelId = await sdk.loadModel({ modelSrc: sdk.QWEN3_5_4B_MULTIMODAL_Q4_K_M, modelConfig: { ctx_size: 8192, tools: true } });
  return {
    provider: createQvacProvider({
      completion: sdk.completion,
      cancel: sdk.cancel,
      getModelId: () => modelId,
      defaultTemperature: 0.1,
      defaultMaxTokens: 512,
      maxThinkingTokens: 512,
    }),
    dispose: async () => {
      await sdk.unloadModel({ modelId });
      await sdk.close();
    },
  };
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

const tools = await createTools();
const { provider, dispose } = await createProvider();
try {
  const skill = loadSkillFromDir(join(packagedSkillsDir(), 'rgb-lightning-node'));
  const skills = new SkillRegistry([skill]);
  const engine = new Engine({ provider, tools: new ToolRegistry([tools.source]), compressToolOutput: true });
  const base = 'You operate the user\'s RGB Lightning Node. Use tools for every value; never invent ids or invoices. Copy invoices exactly. /no_think';

  const steps = [
    'Which RGB assets do I hold, and what are the balances?',
    'Create an RGB invoice so I can receive 10 USDT.',
    ...(recipient() ? [`Send 5 USDT to this RGB invoice: ${recipient()}`] : []),
  ];
  if (!recipient()) console.error('[skipping the send step: set RECIPIENT_INVOICE to an RGB invoice to pay]');

  for (const question of steps) {
    const { system } = skills.compose(base, skill);
    console.error(`\n> ${question}`);
    const result = await engine.runAgentic(
      [
        { role: 'system', content: system },
        { role: 'user', content: question },
      ],
      {
        allowedTools: RLN_TOOLS,
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
