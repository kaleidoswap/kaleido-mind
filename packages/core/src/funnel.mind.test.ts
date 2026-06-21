/**
 * Desktop "mind" smoke tests — drive the SAME Funnel the desktop sidecar builds
 * (apps/provider/src/index.ts: recipes [buyAssetChannel, kaleidoswapAtomic,
 * assetSend, payments, receive] over the MCP tool surface) through each
 * user-facing intent, end to end, with a SCRIPTED provider standing in for the
 * on-device QVAC model.
 *
 * Why mind-level (not just MCP-level, which mcp.live.test.ts covers): the
 * desktop "tool-less" bugs live in the wiring BETWEEN the brain and the tools —
 * tier routing (fast/recipe/agentic), recipe orchestration, and agentic tool
 * selection. These assert that, given a real tool surface, the mind:
 *   - balance        → agentic → calls rln_get_balances, surfaces the balance
 *   - list channels  → agentic → calls rln_list_channels
 *   - buy via swap    → recipe  → quote → init → node → whitelist → execute (1 confirm)
 *   - merchant near city → agentic → search_knowledge over the merchant corpus
 *
 * Fully deterministic (no node/model/maker), so it runs in CI. Live tool
 * execution against a real node is the separate mcp.live.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { Funnel } from './funnel.js';
import { ToolRegistry } from './tools/registry.js';
import { InProcessToolSource } from './tools/in-process.js';
import { merchantsToDocuments } from './knowledge/merchants.js';
import { buyAssetChannelRecipe } from './recipe/buy-asset-channel.js';
import { kaleidoswapAtomicRecipe } from './recipe/kaleidoswap-atomic.js';
import { assetSendRecipe } from './recipe/asset-send.js';
import { paymentsRecipe } from './recipe/payments.js';
import { receiveRecipe } from './recipe/receive.js';
import { loadSkillsDir, packagedSkillsDir } from './skills/loader.js';
import type { Skill } from './skills/types.js';
import type { LLMProvider, TurnInput, TurnOutput } from './providers/types.js';
import type { ConfirmDecision, ToolCall } from './types.js';

// The exact recipe set the desktop provider registers, in order. Order matters:
// kaleidoswapAtomicRecipe is FIRST, so a plain "buy 1 USDT" on a funded node
// routes to the atomic SWAP (BTC→USDT over existing liquidity). The
// channel-onboarding recipe wins only for explicit channel/inbound/liquidity
// phrasing, which the atomic matcher excludes. (See the routing tests below.)
const DESKTOP_RECIPES = [
  kaleidoswapAtomicRecipe,
  buyAssetChannelRecipe,
  assetSendRecipe,
  paymentsRecipe,
  receiveRecipe,
];

// ── A scripted provider: each script entry is one model turn. Returning tool
//    calls makes the agentic engine execute them and ask for the next turn. ──
function scripted(script: Array<{ text: string; toolCalls?: ToolCall[] }>): LLMProvider {
  let turn = 0;
  return {
    name: 'scripted',
    async runTurn(input: TurnInput): Promise<TurnOutput> {
      const step = script[Math.min(turn, script.length - 1)];
      turn += 1;
      input.onToken?.(step.text);
      return { text: step.text, rawContent: step.text, toolCalls: step.toolCalls ?? [], requestId: `req-${turn}` };
    },
  };
}

// ── Merchant corpus: real merchantsToDocuments transform over a small fixture,
//    queried by city so "near Rome" surfaces the Rome places (not Milan). ──
const MERCHANTS = [
  { id: 'm1', name: 'Bitcoin Caffè', category: 'cafe', city: 'Rome', address: 'Via Roma 1', acceptedAssets: ['lightning', 'onchain'] },
  { id: 'm2', name: 'Satoshi Pizzeria', category: 'restaurant', city: 'Milan', acceptedAssets: ['lightning'] },
  { id: 'm3', name: 'Nakamoto Books', category: 'shop', city: 'Rome', address: 'Via Veneto 9', acceptedAssets: ['onchain'] },
];
const MERCHANT_DOCS = merchantsToDocuments(MERCHANTS);
function searchMerchants(query: string): string {
  const q = query.toLowerCase();
  const hits = MERCHANT_DOCS.filter((d) => {
    const city = String((d.metadata as { city?: string })?.city ?? '').toLowerCase();
    return city.length > 0 && q.includes(city);
  });
  return hits.length ? hits.map((h, i) => `[${i + 1}] ${h.text}`).join('\n\n') : 'No relevant passages found.';
}

/**
 * Build the desktop mind with canned MCP-named tools. Every call is recorded in
 * `calls` (name + args, in execution order) so we can assert routing + sequence.
 */
function buildMind(
  provider: LLMProvider,
  opts: { skills?: Skill[]; log?: (m: string) => void } = {},
): { funnel: Funnel; calls: Array<{ name: string; args: any }> } {
  const calls: Array<{ name: string; args: any }> = [];
  const tool = (name: string, response: any, spend = false) => ({
    name,
    description: '',
    parameters: { type: 'object' as const, properties: {} },
    requiresConfirmation: spend,
    handler: async (a: Record<string, unknown>) => {
      calls.push({ name, args: a });
      return typeof response === 'function' ? response(a) : response;
    },
  });

  const tools = new ToolRegistry([
    new InProcessToolSource('wallet', [
      // reads
      tool('rln_get_balances', { lightning_balance_sat: 1_949_753, btc_onchain: { vanilla_spendable_sats: 100_000 } }),
      tool('rln_list_channels', {
        channels: [
          { channel_id: '5d4487c8', capacity_sat: 1_000_000, outbound_balance_msat: 987_240_000, ready: true },
          { channel_id: 'a1b2c3d4', capacity_sat: 1_000_000, outbound_balance_msat: 500_000_000, ready: true },
        ],
      }),
      // atomic-swap chain (quote read; init/whitelist/execute are spends)
      tool('kaleidoswap_get_quote', {
        rfq_id: 'rfq-1',
        from_asset: { asset_id: 'BTC', ticker: 'BTC', amount: 100_000 },
        to_asset: { asset_id: 'rgb:USDT', ticker: 'USDT', amount: 1_000_000 },
        from_amount_display: '100,000 sats',
        to_amount_display: '1 USDT',
        fee_display: '154 sats',
      }),
      tool('kaleidoswap_atomic_init', { swapstring: 'SWAP/abc/def', payment_hash: 'ph-1' }, /* spend */ true),
      tool('rln_get_node_info', { pubkey: '030637ec' }),
      tool('rln_atomic_taker', { ok: true }, /* spend */ true),
      tool('kaleidoswap_atomic_execute', { status: 200, message: 'Swap executed successfully.' }, /* spend */ true),
      // LSPS1 asset-channel onboarding (the rail "buy N USDT" routes to)
      tool('kaleidoswap_lsp_quote_asset_channel', {
        total_sat: 29_946,
        btc_amount_sat: 13_807,
        channel_fee_sat: 16_139,
        expires_at: 0,
      }),
      tool('kaleidoswap_lsp_create_asset_channel', { order_id: 'cf2981c4', order_state: 'CREATED' }, /* spend */ true),
      // knowledge (merchant discovery)
      {
        name: 'search_knowledge',
        description: 'Search the knowledge base (merchants, docs) for relevant passages.',
        parameters: { type: 'object' as const, properties: { query: { type: 'string' } }, required: ['query'] },
        handler: async (a: Record<string, unknown>) => {
          calls.push({ name: 'search_knowledge', args: a });
          return searchMerchants(String(a.query ?? ''));
        },
      },
    ]),
  ]);

  return {
    funnel: new Funnel({ provider, tools, recipes: DESKTOP_RECIPES, maxTurns: 8, skills: opts.skills, log: opts.log }),
    calls,
  };
}

describe('desktop mind — balance', () => {
  it('routes "what\'s my balance?" to the agentic tier and calls rln_get_balances', async () => {
    const { funnel, calls } = buildMind(
      scripted([
        { text: '', toolCalls: [{ name: 'rln_get_balances', arguments: {} }] },
        { text: 'You have 1,949,753 sats in Lightning.' },
      ]),
    );

    const res = await funnel.runTurn("what's my balance?");

    expect(res.tier).toBe('agentic');
    expect(calls.map((c) => c.name)).toContain('rln_get_balances');
    const exec = res.toolCalls?.find((c) => c.name === 'rln_get_balances');
    expect((exec?.result as { lightning_balance_sat?: number })?.lightning_balance_sat).toBe(1_949_753);
    expect(res.text).toBeTruthy();
  });
});

describe('desktop mind — list channels', () => {
  it('routes "list my channels" to the agentic tier and calls rln_list_channels', async () => {
    const { funnel, calls } = buildMind(
      scripted([
        { text: '', toolCalls: [{ name: 'rln_list_channels', arguments: {} }] },
        { text: 'You have 2 open channels.' },
      ]),
    );

    const res = await funnel.runTurn('list my channels');

    expect(res.tier).toBe('agentic');
    expect(calls.map((c) => c.name)).toContain('rln_list_channels');
    const exec = res.toolCalls?.find((c) => c.name === 'rln_list_channels');
    expect((exec?.result as { channels?: unknown[] })?.channels).toHaveLength(2);
  });
});

describe('desktop mind — buy assets via atomic swap', () => {
  it('routes "swap … for usdt" to the atomic recipe and runs quote→init→node→whitelist→execute with ONE confirm', async () => {
    // The recipe forces a model inference for slot extraction (forceModelExtract):
    // the runner injects a synthetic `extract_request` tool; the model fills slots.
    const provider: LLMProvider = {
      name: 'extract',
      async runTurn(input) {
        if (input.tools?.some((t) => t.name === 'extract_request')) {
          return {
            text: '',
            rawContent: '',
            toolCalls: [
              { id: 'ex1', name: 'extract_request', arguments: { from_asset: 'BTC', to_asset: 'USDT', amount: 100_000, amount_side: 'from' } },
            ],
          };
        }
        return { text: '', rawContent: '', toolCalls: [] };
      },
    };

    const { funnel, calls } = buildMind(provider);
    const confirms: Array<{ name: string; summary?: string }> = [];

    const res = await funnel.runTurn('swap 100000 sats for usdt', {
      onConfirm: async (call): Promise<ConfirmDecision> => {
        confirms.push({ name: call.name, summary: call.summary });
        return { approved: true };
      },
    });

    expect(res.tier).toBe('recipe');
    expect(res.route).toBe('kaleidoswap-atomic');
    // The full deterministic chain, in order.
    expect(calls.map((c) => c.name)).toEqual([
      'kaleidoswap_get_quote',
      'kaleidoswap_atomic_init',
      'rln_get_node_info',
      'rln_atomic_taker',
      'kaleidoswap_atomic_execute',
    ]);
    // init sources the asset ids + maker-unit amounts straight from the quote.
    const init = calls.find((c) => c.name === 'kaleidoswap_atomic_init')!;
    expect(init.args).toMatchObject({ rfq_id: 'rfq-1', from_asset: 'BTC', to_asset: 'rgb:USDT' });
    // execute carries the node pubkey as taker_pubkey + the maker's payment_hash.
    const exec = calls.find((c) => c.name === 'kaleidoswap_atomic_execute')!;
    expect(exec.args).toMatchObject({ swapstring: 'SWAP/abc/def', taker_pubkey: '030637ec', payment_hash: 'ph-1' });
    // EXACTLY ONE confirmation gate, fired before the first spend, with real numbers.
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.name).toBe('kaleidoswap_atomic_init');
    expect(confirms[0]!.summary).toMatch(/swap/i);
    expect(res.text).toMatch(/submitted|settling/i);
  });

  it('routes a plain "buy 1 usdt" to the ATOMIC swap (funded node), not channel onboarding', async () => {
    // On a node with existing BTC liquidity, "buy 1 usdt" = swap BTC→USDT, NOT
    // open a new channel. The model fills the implicit source (BTC) + buy leg.
    const buyExtract: LLMProvider = {
      name: 'extract',
      async runTurn(input) {
        if (input.tools?.some((t) => t.name === 'extract_request')) {
          return {
            text: '',
            rawContent: '',
            toolCalls: [
              { id: 'ex1', name: 'extract_request', arguments: { from_asset: 'BTC', to_asset: 'USDT', amount: 1, amount_side: 'to' } },
            ],
          };
        }
        return { text: '', rawContent: '', toolCalls: [] };
      },
    };

    const { funnel, calls } = buildMind(buyExtract);
    const res = await funnel.runTurn('buy 1 usdt', { onConfirm: async () => ({ approved: true }) });

    expect(res.tier).toBe('recipe');
    expect(res.route).toBe('kaleidoswap-atomic');
    expect(calls.map((c) => c.name)).toEqual([
      'kaleidoswap_get_quote',
      'kaleidoswap_atomic_init',
      'rln_get_node_info',
      'rln_atomic_taker',
      'kaleidoswap_atomic_execute',
    ]);
  });

  it('routes explicit inbound-liquidity phrasing to channel onboarding', async () => {
    // The channel-onboarding rail still wins for explicit channel/inbound
    // phrasing (the atomic matcher excludes channel/inbound/liquidity).
    const { funnel } = buildMind(scripted([{ text: '' }]));
    const res = await funnel.runTurn('get 100 usdt inbound liquidity', {
      onConfirm: async () => ({ approved: false }),
    });
    expect(res.tier).toBe('recipe');
    expect(res.route).toBe(buyAssetChannelRecipe.name);
  });
});

describe('desktop mind — find a merchant near a city', () => {
  it('routes "where can I spend bitcoin near Rome" to agentic search_knowledge and surfaces the Rome merchants', async () => {
    const { funnel, calls } = buildMind(
      scripted([
        { text: '', toolCalls: [{ name: 'search_knowledge', arguments: { query: 'bitcoin merchants in Rome' } }] },
        { text: 'Near Rome you can spend at Bitcoin Caffè and Nakamoto Books.' },
      ]),
    );

    const res = await funnel.runTurn('where can I spend bitcoin near Rome?');

    expect(res.tier).toBe('agentic');
    const sk = calls.find((c) => c.name === 'search_knowledge');
    expect(sk).toBeTruthy();
    expect(String(sk!.args.query)).toMatch(/rome/i);
    // Real retrieval over merchantsToDocuments: Rome places in, Milan out.
    const result = String(res.toolCalls?.find((c) => c.name === 'search_knowledge')?.result ?? '');
    expect(result).toMatch(/Bitcoin Caffè/);
    expect(result).toMatch(/Nakamoto Books/);
    expect(result).not.toMatch(/Satoshi Pizzeria|Milan/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Skill scoping — the layer that actually caused the desktop "I cannot check
// your balance, the tool is not available" bug. The agentic tier filters the
// model's tools to the SELECTED SKILL's `tools:` allowlist (engine.ts honours
// allowedTools). If a skill's allowlist names tools that don't exist on the
// host (e.g. `get_balances` while the desktop MCP exposes `rln_get_balances`),
// the real tool is filtered out and the model goes tool-less. These load the
// REAL desktop skills and assert the needed tool survives scoping.
// (The scenario tests above ran skill-LESS, which is exactly why they missed it.)
// ─────────────────────────────────────────────────────────────────────
describe('desktop mind — skill scoping (real skills)', () => {
  const SKILLS = loadSkillsDir(packagedSkillsDir());

  it('loads the real desktop skills', () => {
    expect(SKILLS.length).toBeGreaterThan(0);
    expect(SKILLS.map((s) => s.name)).toEqual(
      expect.arrayContaining(['wallet-assistant', 'rgb-lightning-node', 'kaleido-trading']),
    );
  });

  it('wallet-assistant (triggers on "balance") exposes the real rln_*/wdk_* tool names', () => {
    const wallet = SKILLS.find((s) => s.name === 'wallet-assistant')!;
    expect(wallet.tools).toEqual(expect.arrayContaining(['rln_get_balances', 'wdk_get_balances']));
    expect(wallet.tools).toEqual(expect.arrayContaining(['rln_get_address', 'rln_send_btc', 'rln_create_ln_invoice']));
  });

  it('rgb-lightning-node (triggers on "channels") exposes only canonical rln_* tools', () => {
    const node = SKILLS.find((s) => s.name === 'rgb-lightning-node')!;
    expect(node.tools).toContain('rln_list_channels');
    expect(node.tools?.every((tool) => tool.startsWith('rln_'))).toBe(true);
  });

  it('kaleido-trading drops the phantom kaleidoswap_get_nodeinfo / get_order_history names', () => {
    const trading = SKILLS.find((s) => s.name === 'kaleido-trading')!;
    expect(trading.tools).not.toContain('kaleidoswap_get_nodeinfo');
    expect(trading.tools).not.toContain('kaleidoswap_get_order_history');
    expect(trading.tools).toEqual(expect.arrayContaining(['kaleidoswap_get_quote', 'kaleidoswap_place_order']));
    expect(trading.tools).not.toEqual(
      expect.arrayContaining([
        'kaleidoswap_get_spreads',
        'kaleidoswap_get_open_orders',
        'kaleidoswap_cancel_order',
        'kaleidoswap_get_position',
      ]),
    );
  });

  it('balance through the FULL mind WITH skills loaded still reaches rln_get_balances', async () => {
    const logs: string[] = [];
    const { funnel, calls } = buildMind(
      scripted([
        { text: '', toolCalls: [{ name: 'rln_get_balances', arguments: {} }] },
        { text: 'You have 1,949,753 sats.' },
      ]),
      { skills: SKILLS, log: (m) => logs.push(m) },
    );

    const res = await funnel.runTurn("what's my balance?");

    expect(res.tier).toBe('agentic');
    // wallet-assistant is selected AND rln_get_balances survives its scoping…
    const agenticLine = logs.find((l) => l.startsWith('tier=agentic'));
    expect(agenticLine).toMatch(/skill=wallet-assistant/);
    expect(agenticLine).toMatch(/rln_get_balances/);
    // …and the tool actually executes (not narrated).
    expect(calls.map((c) => c.name)).toContain('rln_get_balances');
  });

  it('list channels through the FULL mind WITH skills loaded reaches rln_list_channels', async () => {
    const { funnel, calls } = buildMind(
      scripted([
        { text: '', toolCalls: [{ name: 'rln_list_channels', arguments: {} }] },
        { text: 'You have 2 channels.' },
      ]),
      { skills: SKILLS },
    );

    const res = await funnel.runTurn('list my channels');

    expect(res.tier).toBe('agentic');
    expect(calls.map((c) => c.name)).toContain('rln_list_channels');
  });
});
