/** Build the agent stack + run the interactive chat REPL. */

import * as readline from 'node:readline';
import { dirname } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  Engine,
  ToolRegistry,
  InProcessToolSource,
  SkillRegistry,
  ContextBuilder,
  InMemoryMemoryStore,
  createMemoryToolSource,
  createRagToolSource,
  createBtcMapToolSource,
  Retriever,
  BITCOIN_COPILOT_DOCS,
  KALEIDOSWAP_TOOLS,
  LSPS1_TOOLS,
  type AgentProfile,
  type InProcessTool,
  type LLMProvider,
  type EmbeddingProvider,
  type MemoryIO,
  type MemoryItem,
  type Message,
  type ToolSource,
} from '@kaleidorg/mind';
import { loadSkillsDir, packagedSkillsDir } from '@kaleidorg/mind/skills';
import { c } from './ui.js';
import { MEMORY_PATH, type CliConfig } from './config.js';
import { getModel } from './catalog.js';
import { modelPath, isInstalled } from './models.js';
import { buildKaleidoswapToolSource } from './kaleidoswapTools.js';
import { buildLsps1ToolSource } from './lsps1Tools.js';
import { btcMapLiveFetch, btcMapLiveLocation, defaultLocationFromEnv } from './btcmapLive.js';

// BTC Map live mode is the default; set KALEIDO_BTCMAP_LIVE=0 to fall back to
// the small bundled offline list (useful in offline dev / CI / unit smoke).
const BTCMAP_LIVE = process.env.KALEIDO_BTCMAP_LIVE !== '0';

const KALEIDOSWAP_BASE_URL = process.env.KALEIDOSWAP_BASE_URL ?? 'http://localhost:8000';
const KALEIDOSWAP_API_KEY = process.env.KALEIDOSWAP_API_KEY;

/** Tool names from the canonical contracts — used as ambient-tool entries. */
const KALEIDOSWAP_NAMES = KALEIDOSWAP_TOOLS.map((t) => t.name);
const LSPS1_NAMES = LSPS1_TOOLS.map((t) => t.name);

const PROFILE: AgentProfile = {
  name: 'KaleidoMind',
  soul: 'A sovereign, local-first AI for Bitcoin, Lightning and RGB. Private, precise, concise. Use a tool to get real data — never invent balances, prices or addresses.',
  instructions: 'Confirm before spending. Keep replies short.',
};

const AMBIENT_TOOLS = [
  'remember', 'recall', 'search_knowledge', 'read_skill_reference',
  'find_merchant_locations', 'get_merchant_info',
  // KaleidoSwap + LSPS1 tools — always callable; the trading / lsps skills
  // give the model focused guidance when their triggers fire.
  ...KALEIDOSWAP_NAMES, ...LSPS1_NAMES,
];

const MOCK_TOOLS: InProcessTool[] = [
  { name: 'wdk_get_balances', description: 'Get wallet balances', parameters: { type: 'object', properties: {} }, handler: async () => ({ btc_sats: 48210, usdt: 12.5, xaut: 0 }) },
  { name: 'wdk_get_node_info', description: 'Node status', parameters: { type: 'object', properties: {} }, handler: async () => ({ pubkey: '02ab…cd', synced: true, blockHeight: 845_000 }) },
  { name: 'wdk_get_address', description: 'Get a receive address', parameters: { type: 'object', properties: {} }, handler: async () => ({ address: 'bc1qexampleaddr…' }) },
  { name: 'wdk_list_channels', description: 'List channels', parameters: { type: 'object', properties: {} }, handler: async () => ([{ id: 'chan1', capacity: 1_000_000, inbound: 600_000, outbound: 400_000 }]) },
  // get_price removed — quotes (including BTC/USD-via-USDT) go through the
  // maker via kaleidoswap_get_quote. No fake spot-price oracle in the CLI.
  // kaleidoswap_get_quote handled by buildKaleidoswapToolSource (real HTTP) — no mock here.
];

const MOCK_ROUTES: { re: RegExp; tool: string }[] = [
  { re: /^remember|note that|save that/i, tool: 'remember' },
  { re: /recall|do you remember|what do you know/i, tool: 'recall' },
  { re: /balance|funds|how much/i, tool: 'wdk_get_balances' },
  { re: /address|receive/i, tool: 'wdk_get_address' },
  { re: /channel/i, tool: 'wdk_list_channels' },
  { re: /node|synced|status/i, tool: 'wdk_get_node_info' },
  // "price"/"worth"/"rate" all route to the maker quote — there is no
  // separate price oracle in this CLI. Mock mode won't have an amount but
  // real mode passes it through normally.
  { re: /quote|swap|trade|price|worth|rate|how (many|much) sats/i, tool: 'kaleidoswap_get_quote' },
  { re: /how do|explain|what is|tell me about|look up|docs/i, tool: 'search_knowledge' },
  { re: /merchant|spend bitcoin|accept bitcoin|near me|where can i|lightning caf[eé]|btc ?map/i, tool: 'find_merchant_locations' },
];

function mockProvider(): LLMProvider {
  return {
    name: 'mock',
    async runTurn(input) {
      const last = input.messages[input.messages.length - 1];
      if (last?.role === 'tool') return { text: `Result: ${String(last.content).slice(0, 400)}`, rawContent: '', toolCalls: [] };
      const user = [...input.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const avail = new Set(input.tools.map((t) => t.name));
      const route = MOCK_ROUTES.find((r) => r.re.test(user) && avail.has(r.tool));
      if (route) {
        const args =
          route.tool === 'remember' ? { text: user.replace(/^.*?(remember|note that|save that)\s*/i, '').trim() || user, kind: 'note' }
            : route.tool === 'recall' || route.tool === 'search_knowledge' ? { query: user }
              : route.tool === 'find_merchant_locations' ? { query: user }
                : {};
        return { text: '', rawContent: '', toolCalls: [{ id: 'mock', name: route.tool, arguments: args }] };
      }
      return { text: `[mock] "${user}" — install a model + run without --mock for a real answer.`, rawContent: '', toolCalls: [] };
    },
  };
}

function mockEmbeddings(): EmbeddingProvider {
  const V = ['balance', 'inbound', 'liquidity', 'channel', 'swap', 'rgb', 'price', 'fee', 'seed', 'lightning', 'onchain', 'lsp', 'invoice', 'receive', 'send'];
  return { dimension: V.length, async embed(texts) { return texts.map((t) => { const l = t.toLowerCase(); return V.map((w) => (l.match(new RegExp(w, 'g'))?.length ?? 0)); }); } };
}

function fileMemoryIO(path: string): MemoryIO {
  return {
    load: async () => { try { return JSON.parse(await readFile(path, 'utf8')) as MemoryItem[]; } catch { return []; } },
    save: async (items) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(items, null, 2)); },
  };
}

export interface Agent {
  provider: LLMProvider;
  tools: ToolRegistry;
  skills: SkillRegistry;
  builder: ContextBuilder;
  memory: InMemoryMemoryStore;
  retriever: Retriever | null;
  mode: 'QVAC' | 'MOCK';
  modelLabel: string;
  sdk: any;
}

export interface BuildOpts {
  mock?: boolean;
  rag?: boolean;
}

/** Assemble the full agent from config + flags. */
export async function buildAgent(cfg: CliConfig, opts: BuildOpts = {}): Promise<Agent> {
  const wantRag = opts.rag ?? cfg.rag;
  const chat = cfg.modelId ? getModel(cfg.modelId) : undefined;

  let sdk: any = null;
  if (!opts.mock) {
    try { sdk = await import('@qvac/sdk'); } catch { /* mock */ }
  }

  let provider: LLMProvider;
  let embeddings: EmbeddingProvider | null = null;
  let modelLabel = 'mock';

  if (sdk && chat && (await isInstalled(chat.id))) {
    const id: string = await sdk.loadModel({ modelSrc: modelPath(chat), modelType: 'llm', modelConfig: { ctx_size: 8192, tools: true } });
    modelLabel = chat.displayName;
    provider = {
      name: 'qvac',
      async runTurn(input) {
        const history = input.system ? [{ role: 'system', content: input.system }, ...input.messages] : input.messages;
        const run: any = sdk.completion({ modelId: id, history, stream: true, tools: input.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) });
        let s = '';
        for await (const ev of run.events) if (ev?.type === 'contentDelta') s += ev.text;
        const final = await run.final;
        const raw = final?.contentText || s || '';
        return { text: raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim(), rawContent: final?.raw?.fullText ?? raw, toolCalls: (final?.toolCalls || []).map((x: any) => ({ id: x.id, name: x.name, arguments: x.arguments ?? {} })) };
      },
    };
    if (wantRag) {
      // Prefer the locally-downloaded GGUF (HTTPS, fast). The catalog points at
      // the same FP16 file QVAC's registry serves, so it loads on their fork.
      // Fall back to the pre-registered GTE_LARGE_FP16 symbol only if the file
      // isn't installed — that path downloads over P2P and can be very slow.
      const emb = getModel('gte-large');
      let modelSrc: any = null;
      if (emb && (await isInstalled('gte-large'))) {
        modelSrc = modelPath(emb);
      } else if ((sdk as any).GTE_LARGE_FP16) {
        modelSrc = (sdk as any).GTE_LARGE_FP16;
      }
      if (modelSrc) {
        try {
          const eid: string = await sdk.loadModel({ modelSrc, modelType: 'embeddings' });
          embeddings = { dimension: 1024, async embed(texts) { const o: number[][] = []; for (const t of texts) o.push((await sdk.embed({ modelId: eid, text: t })).embedding); return o; } };
        } catch (e: any) {
          console.log(c.yellow(`  (RAG embeddings failed to load: ${e?.message ?? e} — RAG disabled)`));
        }
      } else {
        console.log(c.yellow('  (RAG requested but gte-large not available — run `kaleido-mind pull gte-large` or update @qvac/sdk)'));
      }
    }
  } else {
    provider = mockProvider();
    if (wantRag) embeddings = mockEmbeddings();
  }

  const skills = new SkillRegistry(loadSkillsDir(packagedSkillsDir()));
  const memory = new InMemoryMemoryStore({ io: fileMemoryIO(MEMORY_PATH) });
  let retriever: Retriever | null = null;
  if (embeddings) { retriever = new Retriever({ embeddings }); await retriever.ingest(BITCOIN_COPILOT_DOCS); }

  // Live BTC Map by default — hits api.btcmap.org (24h disk cache) and
  // geocodes addresses via Nominatim. Set KALEIDO_BTCMAP_LIVE=0 to use the
  // bundled offline sample. KALEIDO_DEFAULT_LOCATION configures "near me"
  // for the CLI which has no GPS (set to a city name or "lat,lng").
  const defaultLoc = BTCMAP_LIVE ? await defaultLocationFromEnv() : undefined;
  const merchantSource = BTCMAP_LIVE
    ? createBtcMapToolSource({
        fetch: btcMapLiveFetch,
        location: btcMapLiveLocation(defaultLoc),
      })
    : createBtcMapToolSource();

  const sources: ToolSource[] = [
    new InProcessToolSource('wallet', MOCK_TOOLS),
    createMemoryToolSource(memory),
    merchantSource,
    // KaleidoSwap maker — fetch-based, defaults to localhost:8000 for the demo.
    // The mind never sees the URL; the HTTP call lives in kaleidoswapTools.ts.
    buildKaleidoswapToolSource({ baseUrl: KALEIDOSWAP_BASE_URL, apiKey: KALEIDOSWAP_API_KEY }),
    // LSPS1 channel orders — same base URL, LSP-agnostic tool names.
    buildLsps1ToolSource({ baseUrl: KALEIDOSWAP_BASE_URL, apiKey: KALEIDOSWAP_API_KEY }),
  ];
  if (retriever) sources.push(createRagToolSource(retriever));

  return {
    provider,
    tools: new ToolRegistry(sources),
    skills,
    memory,
    retriever,
    builder: new ContextBuilder({ profile: PROFILE, memory, retriever: retriever ?? undefined, topKMemory: 3, budgetTokens: 2000 }),
    mode: sdk && chat ? 'QVAC' : 'MOCK',
    modelLabel,
    sdk,
  };
}

export interface TurnHooks {
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: unknown) => void;
  onConfirm?: (name: string) => boolean;
}

export interface TurnReport {
  skill: string | null;
  text: string;
  toolCalls: { name: string; arguments: Record<string, unknown> }[];
  turns: number;
  latencyMs: number;
}

/**
 * Run ONE agent turn (skill route → compose context → runAgentic), shared by
 * the REPL and the benchmark. Keeps cross-cutting tools reachable under a
 * tool-scoped skill.
 */
export async function agentTurn(
  agent: Agent,
  text: string,
  history: Message[] = [],
  hooks: TurnHooks = {},
): Promise<TurnReport> {
  const skill = agent.skills.select(text);
  const { system: skillSystem, allowedTools } = agent.skills.compose('', skill);
  const { system } = await agent.builder.build({ query: text, skillSystem });
  const effective = allowedTools ? [...new Set([...allowedTools, ...AMBIENT_TOOLS])] : undefined;
  const engine = new Engine({ provider: agent.provider, tools: agent.tools, defaultSystem: system, defaultMaxTurns: 6 });
  const res = await engine.runAgentic([...history, { role: 'user', content: text }], {
    allowedTools: effective,
    onToolCall: (c) => hooks.onToolCall?.(c.name, c.arguments),
    onToolResult: (e) => hooks.onToolResult?.(e.name, e.result),
    onConfirm: async (c) => ({ approved: hooks.onConfirm ? hooks.onConfirm(c.name) : true }),
  });
  return {
    skill: skill?.name ?? null,
    text: res.text,
    toolCalls: res.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
    turns: res.turns,
    latencyMs: res.latencyMs,
  };
}

/** Interactive REPL over a built agent. */
export async function runChat(agent: Agent): Promise<void> {
  const { tools, skills, memory, retriever } = agent;
  const modeColor = agent.mode === 'QVAC' ? c.green : c.yellow;
  console.log(`${c.violet('chat')} ${c.dim('·')} ${modeColor(agent.mode)} ${c.dim('·')} ${c.bold(agent.modelLabel)} ${c.dim(`· ${skills.list().length} skills · RAG ${retriever ? 'on' : 'off'}`)}`);
  console.log(c.dim('type a message · /help for commands · Ctrl-D to exit\n'));

  const history: Message[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdout.isTTY });
  const prompt = () => { if (process.stdout.isTTY) { rl.setPrompt(`${c.violet('🧠 ')}`); rl.prompt(); } };

  async function handle(line: string): Promise<void> {
    const text = line.trim();
    if (!text) return;
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(' ');
      const a = rest.join(' ').trim();
      switch (cmd) {
        case 'help': console.log(c.dim('  /skills  /tools  /mem  /forget  /ingest <text>  /search <q>  /reset  /quit')); break;
        case 'skills': for (const s of skills.list()) console.log(`  ${c.cyan(s.name)} ${c.dim('— ' + s.description.slice(0, 70))}`); break;
        case 'tools': for (const t of await tools.listTools()) console.log(`  ${c.teal(t.name)} ${c.dim('— ' + t.description.slice(0, 64))}`); break;
        case 'mem': { const items = await memory.all(); if (!items.length) console.log(c.dim('  (empty)')); for (const m of items) console.log(`  ${c.dim('(' + m.kind + ')')} ${m.text}`); break; }
        case 'forget': await memory.clear(); console.log(c.dim('  memory cleared')); break;
        case 'ingest': if (!retriever) { console.log(c.yellow('  RAG off — run with --rag')); break; } await retriever.ingest([{ text: a }]); console.log(c.dim('  ingested')); break;
        case 'search': { if (!retriever) { console.log(c.yellow('  RAG off — run with --rag')); break; } for (const h of await retriever.search(a, 3)) console.log(`  ${c.dim('(' + h.score.toFixed(2) + ')')} ${h.text.slice(0, 90)}`); break; }
        case 'reset': history.length = 0; console.log(c.dim('  reset')); break;
        case 'quit': case 'exit': rl.close(); return;
        default: console.log(c.yellow(`  unknown: /${cmd}`));
      }
      return;
    }

    try {
      const verbose = process.env.KALEIDO_VERBOSE === '1';
      const preview = (v: unknown, max = 240) => {
        const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
        return s.length > max ? s.slice(0, max) + '…' : s;
      };
      const rep = await agentTurn(agent, text, history, {
        onToolCall: (name, args) => console.log(c.cyan(`  🔧 ${name}(${JSON.stringify(args).slice(0, 60)})`)),
        onToolResult: (name, result) => {
          // Errors are always shown; full results behind KALEIDO_VERBOSE=1.
          const r = result as any;
          const looksError = r && typeof r === 'object' && 'error' in r;
          if (looksError) {
            console.log(c.yellow(`     ⤺ ${name} → error: ${preview(r.error, 300)}`));
          } else if (verbose) {
            console.log(c.dim(`     ⤺ ${name} → ${preview(result, 400)}`));
          }
        },
        onConfirm: (name) => { console.log(c.yellow(`  ⚠ auto-approving ${name}`)); return true; },
      });
      if (rep.skill) console.log(c.dim(`  ↳ skill: ${rep.skill}`));
      console.log(`${c.green('🤖')} ${rep.text || '(no text)'}\n`);
      history.push({ role: 'user', content: text }, { role: 'assistant', content: rep.text });
    } catch (e) { console.log(c.yellow(`  error: ${(e as Error).message}\n`)); }
  }

  prompt();
  for await (const line of rl) { await handle(line); prompt(); }
  if (agent.sdk?.close) await agent.sdk.close();
}
