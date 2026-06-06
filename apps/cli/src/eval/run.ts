/**
 * Eval runner — present the SAME capabilities via 4 mechanisms and grade how
 * well each model uses them. Execution is stubbed (canned tool results) so we
 * measure model behaviour reproducibly + offline.
 *
 *   fc     curated structured tools (few)
 *   mcp    structured tools at scale (curated + decoys ≈ 60) — selection stress
 *   skill  skill-scoped structured tools (progressive disclosure, our default)
 *   cli    skill → free-form `run_command "kaleido …"`
 */

import {
  Engine,
  ToolRegistry,
  InProcessToolSource,
  SkillRegistry,
  createCliToolSource,
  type InProcessTool,
  type LLMProvider,
  type ToolSource,
} from '@kaleidorg/mind';
import { loadSkillsDir, packagedSkillsDir } from '@kaleidorg/mind/skills';
import { getModel } from '../catalog.js';
import { modelPath, isInstalled } from '../models.js';
import type { EvalCase } from './dataset.js';

export type Mechanism = 'fc' | 'mcp' | 'skill' | 'cli';
export const MECHANISMS: Mechanism[] = ['fc', 'mcp', 'skill', 'cli'];

const SOUL =
  'You are KaleidoMind, a local-first Bitcoin wallet assistant. To do anything, ' +
  'call a tool — never invent balances, prices, addresses or results. If the user ' +
  'is just greeting you, reply briefly and do NOT call any tool.';

// Curated tools the model should choose among (stub handlers — deterministic).
const CANNED: Record<string, unknown> = {
  wdk_get_balances: { btc_sats: 48210, usdt: 12.5 },
  wdk_get_address: { address: 'bc1qexample' },
  wdk_list_channels: [{ id: 'c1', capacity: 1_000_000 }],
  wdk_get_node_info: { synced: true },
  wdk_pay_invoice: { paid: true },
  wdk_send_btc: { txid: 'abcd' },
  wdk_create_ln_invoice: { invoice: 'lnbc…' },
  get_price: { btc_usd: 71500 },
  get_market_data: { btc_usd: 71500, change_24h: 1.8 },
  kaleidoswap_get_quote: { out: 71.5, fees_sat: 120 },
  kaleidoswap_place_order: { orderId: 'o1' },
  remember: 'saved',
  recall: '- (note) prefers Lightning',
  search_knowledge: 'Inbound liquidity lets you receive; buy a channel from the LSP.',
};
const curatedTool = (name: string): InProcessTool => ({
  name,
  description: descFor(name),
  parameters: { type: 'object', properties: argSchema(name) },
  handler: async () => CANNED[name] ?? 'ok',
});
function descFor(n: string): string {
  const d: Record<string, string> = {
    wdk_get_balances: 'Get wallet balances (BTC + assets)',
    wdk_get_address: 'Get a new on-chain receive address',
    wdk_list_channels: 'List Lightning channels',
    wdk_get_node_info: 'Get node status / sync state',
    wdk_pay_invoice: 'Pay a Lightning invoice or send sats to a contact',
    wdk_send_btc: 'Send on-chain BTC to an address',
    wdk_create_ln_invoice: 'Create a Lightning invoice to receive',
    get_price: 'Get the current BTC price',
    get_market_data: 'Get market data (price, 24h change)',
    kaleidoswap_get_quote: 'Quote a swap between BTC and an RGB asset',
    kaleidoswap_place_order: 'Place a swap order',
    remember: 'Save a fact/preference to long-term memory',
    recall: 'Recall facts from long-term memory',
    search_knowledge: 'Search the Bitcoin/Lightning knowledge base',
  };
  return d[n] ?? n;
}
function argSchema(n: string): Record<string, unknown> {
  if (n === 'wdk_pay_invoice') return { amount_sats: { type: 'number' }, to: { type: 'string' } };
  if (n === 'kaleidoswap_get_quote') return { pair: { type: 'string' }, amount: { type: 'number' } };
  if (n === 'remember') return { text: { type: 'string' } };
  if (n === 'recall' || n === 'search_knowledge') return { query: { type: 'string' } };
  return {};
}

const CURATED = Object.keys(CANNED);
const AMBIENT = ['remember', 'recall', 'search_knowledge'];

// Decoys to simulate the MCP "many tools" surface (selection-at-scale stress).
const DECOYS = [
  'wdk_export_logs', 'wdk_backup_channels', 'wdk_close_channel', 'wdk_open_channel', 'wdk_sign_message',
  'wdk_decode_invoice', 'wdk_list_peers', 'wdk_connect_peer', 'wdk_disconnect_peer', 'wdk_estimate_fee',
  'kaleidoswap_cancel_order', 'kaleidoswap_get_pairs', 'kaleidoswap_get_position', 'kaleidoswap_get_spreads',
  'kaleidoswap_lsp_get_info', 'kaleidoswap_lsp_create_order', 'kaleidoswap_get_order_status', 'kaleidoswap_atomic_init',
  'rgb_list_assets', 'rgb_send_asset', 'rgb_get_asset_balance', 'rgb_create_invoice', 'rgb_refresh_transfers',
  'nostr_get_contacts', 'nostr_send_dm', 'nostr_publish_note', 'nostr_zap',
  'get_sentiment', 'get_ohlcv', 'get_fear_greed', 'convert_currency', 'get_network_stats',
  'system_get_time', 'system_get_weather', 'translate_text', 'summarize_text', 'set_reminder',
  'contacts_add', 'contacts_search', 'map_find_merchants', 'map_directions', 'bitrefill_search',
  'bitrefill_buy', 'bitrefill_order_status', 'l402_fetch', 'mpp_pay', 'dca_set_schedule',
].map((name): InProcessTool => ({ name, description: name.replace(/_/g, ' '), parameters: { type: 'object', properties: {} }, handler: async () => 'ok' }));

const cliRunner = { run: async (command: string) => ({ stdout: `ran: ${command}`, stderr: '', code: 0 }) };

export interface CaseResult {
  model: string;
  mechanism: Mechanism;
  case: EvalCase;
  toolCalls: { name: string; arguments: Record<string, unknown> }[];
  text: string;
  turns: number;
  latencyMs: number;
  applicable: boolean;
  selectionOk: boolean;
  argsOk: boolean;
  skillOk: boolean;
  overTriggered: boolean; // called a tool on a negative
  pass: boolean;
}

const skills = new SkillRegistry(loadSkillsDir(packagedSkillsDir()));

/** Build the tool registry + system + allowedTools for a mechanism on a case. */
function setup(mech: Mechanism, c: EvalCase): { tools: ToolRegistry; system: string; allowed?: string[] } {
  const curated = new InProcessToolSource('curated', CURATED.map(curatedTool));
  if (mech === 'fc') return { tools: new ToolRegistry([curated]), system: SOUL };
  if (mech === 'mcp') {
    const all = new InProcessToolSource('mcp', [...CURATED.map(curatedTool), ...DECOYS]);
    return { tools: new ToolRegistry([all as ToolSource]), system: SOUL };
  }
  if (mech === 'skill') {
    const skill = skills.select(c.prompt);
    const { system, allowedTools } = skills.compose(SOUL, skill);
    const allowed = allowedTools ? [...new Set([...allowedTools, ...AMBIENT])] : undefined;
    return { tools: new ToolRegistry([curated]), system, allowed };
  }
  // cli
  const cli = createCliToolSource({ runner: cliRunner, allow: ['kaleido'], requiresConfirmation: false });
  const system = `${SOUL}\n\nYou operate the wallet through a CLI. To do ANYTHING, call run_command with a single \`kaleido …\` command, e.g. \`kaleido wallet balance\`, \`kaleido price\`, \`kaleido pay <invoice>\`.`;
  return { tools: new ToolRegistry([cli]), system, allowed: ['run_command'] };
}

function grade(c: EvalCase, mech: Mechanism, calls: { name: string; arguments: Record<string, unknown> }[], text: string) {
  const names = calls.map((t) => t.name);
  const skillOk = !c.expectSkill || skills.select(c.prompt)?.name === c.expectSkill;
  const answered = text.trim().length > 0 || names.length > 0;

  if (mech === 'cli') {
    if (!c.expectCli) return { applicable: false, selectionOk: false, argsOk: true, skillOk, overTriggered: false, pass: false };
    const cmd = String(calls.find((t) => t.name === 'run_command')?.arguments?.command ?? '').toLowerCase();
    const ok = c.expectCli.toLowerCase().split(' ').every((tok) => cmd.includes(tok));
    return { applicable: true, selectionOk: ok, argsOk: true, skillOk, overTriggered: false, pass: ok };
  }
  if (c.expectTool === null) {
    const ok = names.length === 0;
    return { applicable: true, selectionOk: ok, argsOk: true, skillOk, overTriggered: !ok, pass: ok };
  }
  if (typeof c.expectTool === 'string') {
    const sel = names.includes(c.expectTool);
    let argsOk = true;
    if (sel && c.expectArgs) {
      const a = JSON.stringify(calls.find((t) => t.name === c.expectTool)?.arguments ?? {});
      argsOk = c.expectArgs.every((x) => a.includes(x));
    }
    return { applicable: true, selectionOk: sel, argsOk, skillOk, overTriggered: false, pass: sel && argsOk };
  }
  // expectTool undefined (commerce) — pass if it answered/routed sensibly.
  return { applicable: true, selectionOk: answered, argsOk: true, skillOk, overTriggered: false, pass: answered && skillOk };
}

/** Run one case under one mechanism on the given provider. */
export async function runCase(provider: LLMProvider, model: string, mech: Mechanism, c: EvalCase): Promise<CaseResult> {
  const { tools, system, allowed } = setup(mech, c);
  const engine = new Engine({ provider, tools, defaultSystem: system, defaultMaxTurns: 4 });
  let toolCalls: { name: string; arguments: Record<string, unknown> }[] = [];
  let text = '';
  let turns = 0;
  let latencyMs = 0;
  try {
    const res = await engine.runAgentic([{ role: 'user', content: c.prompt }], {
      allowedTools: allowed,
      onConfirm: async () => ({ approved: true }),
    });
    toolCalls = res.toolCalls.map((t) => ({ name: t.name, arguments: t.arguments }));
    text = res.text;
    turns = res.turns;
    latencyMs = res.latencyMs;
  } catch {
    /* record empty */
  }
  const g = grade(c, mech, toolCalls, text);
  return { model, mechanism: mech, case: c, toolCalls, text, turns, latencyMs, ...g };
}

// Keyword → tool, for the offline mock provider (verifies the harness + report).
const KW: [RegExp, string][] = [
  [/balance|how much|sats/i, 'wdk_get_balances'],
  [/address|receive|deposit|get paid/i, 'wdk_get_address'],
  [/channel/i, 'wdk_list_channels'],
  [/node|synced|online/i, 'wdk_get_node_info'],
  [/\bpay\b|\bsend\b/i, 'wdk_pay_invoice'],
  [/price|worth/i, 'get_price'],
  [/quote|swap/i, 'kaleidoswap_get_quote'],
  [/remember|note that|save that/i, 'remember'],
  [/what do you remember|preferences|recall/i, 'recall'],
  [/how do|what is|explain|work/i, 'search_knowledge'],
];
const CLIMAP: Record<string, string> = {
  wdk_get_balances: 'kaleido wallet balance', wdk_get_address: 'kaleido wallet address',
  wdk_list_channels: 'kaleido channel list', wdk_get_node_info: 'kaleido node info',
  wdk_pay_invoice: 'kaleido pay invoice', get_price: 'kaleido price', kaleidoswap_get_quote: 'kaleido quote',
};

/** Deterministic mock provider — keyword routing, for offline harness checks. */
export function mockEvalProvider(): LLMProvider {
  return {
    name: 'mock',
    async runTurn(input) {
      const last = input.messages[input.messages.length - 1];
      if (last?.role === 'tool') return { text: `Done: ${String(last.content).slice(0, 120)}`, rawContent: '', toolCalls: [] };
      const user = [...input.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const avail = new Set(input.tools.map((t) => t.name));
      const hit = KW.find(([re]) => re.test(user));
      if (avail.has('run_command')) {
        const cmd = hit ? CLIMAP[hit[1]] : undefined;
        if (cmd) return { text: '', rawContent: '', toolCalls: [{ id: 'm', name: 'run_command', arguments: { command: cmd } }] };
        return { text: 'Hello! How can I help with your wallet?', rawContent: '', toolCalls: [] };
      }
      if (hit && avail.has(hit[1])) {
        const tool = hit[1];
        const args = tool === 'remember' ? { text: user } : tool === 'recall' || tool === 'search_knowledge' ? { query: user } : tool === 'wdk_pay_invoice' ? { amount_sats: Number(user.match(/\d+/)?.[0] ?? 0) } : tool === 'kaleidoswap_get_quote' ? { pair: (user.match(/BTC\/\w+/i)?.[0] ?? 'BTC/USDT') } : {};
        return { text: '', rawContent: '', toolCalls: [{ id: 'm', name: tool, arguments: args }] };
      }
      return { text: 'Hi! Ask me about your balance, price, channels, or to buy something.', rawContent: '', toolCalls: [] };
    },
  };
}

/** A QVAC LLM provider for a catalog model, or null if not loadable. */
export async function loadProvider(modelId: string, sdk: any): Promise<{ provider: LLMProvider; modelId: string } | null> {
  const m = getModel(modelId);
  if (!m || !(await isInstalled(modelId))) return null;
  const id: string = await sdk.loadModel({ modelSrc: modelPath(m), modelType: 'llm', modelConfig: { ctx_size: 8192, tools: true } });
  return {
    modelId: id,
    provider: {
      name: 'qvac',
      async runTurn(input) {
        const history = input.system ? [{ role: 'system', content: input.system }, ...input.messages] : input.messages;
        const run: any = sdk.completion({ modelId: id, history, stream: false, tools: input.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) });
        const final = await run.final;
        const raw = final?.contentText || '';
        return { text: raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim(), rawContent: final?.raw?.fullText ?? raw, toolCalls: (final?.toolCalls || []).map((x: any) => ({ id: x.id, name: x.name, arguments: x.arguments ?? {} })) };
      },
    },
  };
}
