/**
 * Eval runner (v2) — present the SAME capabilities three ways and measure how
 * well each model *decides* which tool to use. We grade the model's FIRST
 * action (decision-only: one inference, no execution, no summary turn) so the
 * metric is "did it choose the right tool with the right args" — fast + sharp.
 *
 *   fc     curated structured tools (few)
 *   mcp    structured tools at scale (curated + ~46 decoys ≈ 60) — selection stress
 *   skill  a skill scopes tools to ~3-9 + injects a playbook (our portable default;
 *          works on mobile where CLI doesn't exist)
 *
 * Each case is run K times (temperature 0) so we report a pass-rate + how
 * reliable (consistent) the model is, not a single coin-flip.
 */

import {
  ToolRegistry,
  InProcessToolSource,
  SkillRegistry,
  type InProcessTool,
  type LLMProvider,
  type ToolDef,
  type ToolSource,
} from '@kaleidorg/mind';
import { loadSkillsDir, packagedSkillsDir } from '@kaleidorg/mind/skills';
import { getModel } from '../catalog.js';
import { modelPath, isInstalled } from '../models.js';
import type { EvalCase } from './dataset.js';

export type Mechanism = 'fc' | 'mcp' | 'skill';
export const MECHANISMS: Mechanism[] = ['fc', 'mcp', 'skill'];

const SOUL =
  'You are KaleidoMind, a local-first Bitcoin wallet assistant. To do anything, ' +
  'call a tool — never invent balances, prices, addresses or results. If the user ' +
  'is just greeting you, reply briefly and do NOT call any tool.';

const TOOL_DESC: Record<string, string> = {
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
function argSchema(n: string): Record<string, unknown> {
  if (n === 'wdk_pay_invoice') return { amount_sats: { type: 'number' }, to: { type: 'string' } };
  if (n === 'kaleidoswap_get_quote') return { pair: { type: 'string' }, amount: { type: 'number' } };
  if (n === 'remember') return { text: { type: 'string' } };
  if (n === 'recall' || n === 'search_knowledge') return { query: { type: 'string' } };
  return {};
}
const curatedTool = (name: string): InProcessTool => ({
  name,
  description: TOOL_DESC[name] ?? name,
  parameters: { type: 'object', properties: argSchema(name) },
  handler: async () => 'ok', // never executed (decision-only)
});

const CURATED = Object.keys(TOOL_DESC);
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

export interface CaseResult {
  model: string;
  mechanism: Mechanism;
  repeat: number;
  case: EvalCase;
  toolCalls: { name: string; arguments: Record<string, unknown> }[];
  text: string;
  latencyMs: number;
  applicable: boolean;
  selectionOk: boolean;
  argsOk: boolean;
  skillOk: boolean;
  overTriggered: boolean;
  pass: boolean;
}

const skills = new SkillRegistry(loadSkillsDir(packagedSkillsDir()));

/** Tools + system + allowlist for a mechanism on a case (decision-only — no exec). */
function setup(mech: Mechanism, c: EvalCase): { tools: ToolRegistry; system: string; allowed?: string[] } {
  const curated = new InProcessToolSource('curated', CURATED.map(curatedTool));
  if (mech === 'fc') return { tools: new ToolRegistry([curated]), system: SOUL };
  if (mech === 'mcp') {
    const all = new InProcessToolSource('mcp', [...CURATED.map(curatedTool), ...DECOYS]);
    return { tools: new ToolRegistry([all as ToolSource]), system: SOUL };
  }
  // skill — narrow the tools + inject the playbook (portable: structured tools).
  const skill = skills.select(c.prompt);
  const { system, allowedTools } = skills.compose(SOUL, skill);
  const allowed = allowedTools ? [...new Set([...allowedTools, ...AMBIENT])] : undefined;
  return { tools: new ToolRegistry([curated]), system, allowed };
}

/** Lenient value match: do all expected substrings appear in the args JSON? */
function argsMatch(args: Record<string, unknown>, expect: string[]): boolean {
  const blob = JSON.stringify(args).toLowerCase().replace(/,/g, '');
  return expect.every((x) => blob.includes(x.toLowerCase().replace(/,/g, '')));
}

function grade(c: EvalCase, calls: { name: string; arguments: Record<string, unknown> }[], text: string) {
  const names = calls.map((t) => t.name);
  const skillOk = !c.expectSkill || skills.select(c.prompt)?.name === c.expectSkill;
  const answered = text.trim().length > 0 || names.length > 0;

  if (c.expectTool === null) {
    const ok = names.length === 0; // negative: must NOT call a tool
    return { applicable: true, selectionOk: ok, argsOk: true, skillOk, overTriggered: !ok, pass: ok };
  }
  if (typeof c.expectTool === 'string') {
    const sel = names.includes(c.expectTool);
    const argsOk = sel && c.expectArgs ? argsMatch(calls.find((t) => t.name === c.expectTool)!.arguments, c.expectArgs) : true;
    return { applicable: true, selectionOk: sel, argsOk, skillOk, overTriggered: false, pass: sel && argsOk };
  }
  // expectTool undefined (commerce) — pass if it routed sensibly (skill) + answered.
  return { applicable: true, selectionOk: answered, argsOk: true, skillOk, overTriggered: false, pass: answered && skillOk };
}

/** Decision-only: one model turn, grade the tool call it emits. No execution. */
export async function runCase(provider: LLMProvider, model: string, mech: Mechanism, c: EvalCase, repeat: number): Promise<CaseResult> {
  const { tools, system, allowed } = setup(mech, c);
  const all = await tools.listTools();
  const toolDefs: ToolDef[] = allowed ? all.filter((t) => allowed.includes(t.name)) : all;

  const t0 = Date.now();
  let toolCalls: { name: string; arguments: Record<string, unknown> }[] = [];
  let text = '';
  try {
    const out = await provider.runTurn({ system, messages: [{ role: 'user', content: c.prompt }], tools: toolDefs });
    toolCalls = (out.toolCalls ?? []).map((t) => ({ name: t.name, arguments: t.arguments }));
    text = out.text ?? '';
  } catch { /* record empty */ }
  const latencyMs = Date.now() - t0;
  const g = grade(c, toolCalls, text);
  return { model, mechanism: mech, repeat, case: c, toolCalls, text, latencyMs, ...g };
}

// ── Mock provider (offline harness checks) ───────────────────────────────────
const KW: [RegExp, string][] = [
  [/^remember|note that|save that/i, 'remember'],
  [/recall|do you remember|what do you know|preferences/i, 'recall'],
  [/balance|funds|how much/i, 'wdk_get_balances'],
  [/address|receive/i, 'wdk_get_address'],
  [/channel/i, 'wdk_list_channels'],
  [/node|synced|status/i, 'wdk_get_node_info'],
  [/\bpay\b|\bsend\b/i, 'wdk_pay_invoice'],
  [/price|worth/i, 'get_price'],
  [/quote|swap|trade/i, 'kaleidoswap_get_quote'],
  [/how do|explain|what is|tell me about/i, 'search_knowledge'],
];
export function mockEvalProvider(): LLMProvider {
  return {
    name: 'mock',
    async runTurn(input) {
      const user = [...input.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const avail = new Set(input.tools.map((t) => t.name));
      const hit = KW.find(([re]) => re.test(user));
      if (hit && avail.has(hit[1])) {
        const tool = hit[1];
        const args = tool === 'remember' ? { text: user }
          : tool === 'recall' || tool === 'search_knowledge' ? { query: user }
            : tool === 'wdk_pay_invoice' ? { amount_sats: Number(user.match(/\d+/)?.[0] ?? 0) }
              : tool === 'kaleidoswap_get_quote' ? { pair: user.match(/BTC\/\w+/i)?.[0] ?? 'BTC/USDT' } : {};
        return { text: '', rawContent: '', toolCalls: [{ id: 'm', name: tool, arguments: args }] };
      }
      return { text: 'Hi! Ask me about your balance, price, channels, or to buy something.', rawContent: '', toolCalls: [] };
    },
  };
}

/** A QVAC LLM provider for a catalog model (temperature 0 for repeatability). */
export async function loadProvider(modelId: string, sdk: any): Promise<{ provider: LLMProvider; modelId: string } | null> {
  const m = getModel(modelId);
  if (!m || !(await isInstalled(modelId))) return null;
  const id: string = await sdk.loadModel({ modelSrc: modelPath(m), modelType: 'llm', modelConfig: { ctx_size: 8192, tools: true, ...(sdk.VERBOSITY ? { verbosity: sdk.VERBOSITY.ERROR } : {}) } });
  return {
    modelId: id,
    provider: {
      name: 'qvac',
      async runTurn(input) {
        const history = input.system ? [{ role: 'system', content: input.system }, ...input.messages] : input.messages;
        const run: any = sdk.completion({
          modelId: id, history, stream: false, temperature: 0,
          tools: input.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
        });
        const final = await run.final;
        const raw = final?.contentText || '';
        return { text: raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim(), rawContent: final?.raw?.fullText ?? raw, toolCalls: (final?.toolCalls || []).map((x: any) => ({ id: x.id, name: x.name, arguments: x.arguments ?? {} })) };
      },
    },
  };
}
