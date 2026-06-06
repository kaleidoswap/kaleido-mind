#!/usr/bin/env node
/**
 * kaleido-mind CLI — interactive terminal harness for the agent.
 *
 * Runs the FULL stack on your Mac so you can test before mobile/desktop:
 * QVAC provider + skills (routing) + memory (persisted) + optional RAG + tools.
 * If @qvac/sdk can't load (or --mock), it falls back to a deterministic mock
 * provider + mock tools so the loop, skills, memory and commands still work.
 *
 *   pnpm --filter @kaleidorg/mind-cli start                 # interactive
 *   pnpm --filter @kaleidorg/mind-cli start -- --mock       # no model needed
 *   QVAC_MODEL_PATH=~/.kaleido/models/Qwen3-4B-Q4_K_M.gguf \
 *     pnpm --filter @kaleidorg/mind-cli start -- --rag
 *   echo "what's my balance" | pnpm --filter @kaleidorg/mind-cli start -- --mock
 *
 * Flags: --mock  --rag  --model <path>  --mcp <entry.js>
 * Commands in the REPL: /help /skills /mem /forget /ingest /search /reset /quit
 */

import * as readline from 'node:readline';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
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
  Retriever,
  BITCOIN_COPILOT_DOCS,
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

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  violet: (s: string) => `\x1b[35m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

const PROFILE: AgentProfile = {
  name: 'KaleidoMind',
  soul: 'A sovereign, local-first AI for Bitcoin, Lightning and RGB. Private, precise, concise. Use a tool to get real data — never invent balances, prices or addresses.',
  instructions: 'Confirm before spending. Keep replies short.',
};

// ── Mock tools (so the agent loop is testable without a wallet/MCP) ──────────
const MOCK_TOOLS: InProcessTool[] = [
  { name: 'wdk_get_balances', description: 'Get wallet balances', parameters: { type: 'object', properties: {} }, handler: async () => ({ btc_sats: 48210, usdt: 12.5, xaut: 0 }) },
  { name: 'wdk_get_asset_balance', description: 'Get an RGB asset balance', parameters: { type: 'object', properties: { asset: { type: 'string' } } }, handler: async (a: any) => ({ asset: a.asset ?? 'USDT', amount: 12.5 }) },
  { name: 'wdk_get_node_info', description: 'Node status', parameters: { type: 'object', properties: {} }, handler: async () => ({ pubkey: '02ab…cd', synced: true, blockHeight: 845_000 }) },
  { name: 'wdk_get_address', description: 'Get a receive address', parameters: { type: 'object', properties: {} }, handler: async () => ({ address: 'bc1qexampleaddr…' }) },
  { name: 'wdk_list_channels', description: 'List channels', parameters: { type: 'object', properties: {} }, handler: async () => ([{ id: 'chan1', capacity: 1_000_000, inbound: 600_000, outbound: 400_000 }]) },
  { name: 'get_price', description: 'BTC price', parameters: { type: 'object', properties: {} }, handler: async () => ({ btc_usd: 71_500 }) },
  { name: 'get_market_data', description: 'Market data', parameters: { type: 'object', properties: {} }, handler: async () => ({ btc_usd: 71_500, change_24h_pct: 1.8 }) },
  { name: 'kaleidoswap_get_quote', description: 'Quote a swap', parameters: { type: 'object', properties: { pair: { type: 'string' }, amount: { type: 'number' } } }, handler: async (a: any) => ({ pair: a.pair ?? 'BTC/USDT', in: a.amount ?? 0.001, out: 71.5, fees_sat: 120 }) },
  { name: 'kaleidoswap_get_pairs', description: 'List pairs', parameters: { type: 'object', properties: {} }, handler: async () => (['BTC/USDT', 'BTC/XAUT', 'XAUT/USDT']) },
];

// Cross-cutting tools available regardless of the active skill's tool scope.
const AMBIENT_TOOLS = ['remember', 'recall', 'search_knowledge', 'read_skill_reference'];

// keyword → tool, for the mock provider to "decide" a call deterministically.
// Order matters: specific intents first, the broad "explainer → RAG" route last.
const MOCK_ROUTES: { re: RegExp; tool: string }[] = [
  { re: /^remember|note that|save that/i, tool: 'remember' },
  { re: /recall|what do you know|do you remember/i, tool: 'recall' },
  { re: /balance|funds|how much/i, tool: 'wdk_get_balances' },
  { re: /address|receive/i, tool: 'wdk_get_address' },
  { re: /channel/i, tool: 'wdk_list_channels' },
  { re: /node|synced|status/i, tool: 'wdk_get_node_info' },
  { re: /price|worth/i, tool: 'get_price' },
  { re: /quote|swap|trade/i, tool: 'kaleidoswap_get_quote' },
  { re: /how do|explain|what is|tell me about|look up|docs/i, tool: 'search_knowledge' },
];

function mockProvider(): LLMProvider {
  return {
    name: 'mock',
    async runTurn(input) {
      const msgs = input.messages;
      const last = msgs[msgs.length - 1];
      if (last?.role === 'tool') {
        return { text: `Result: ${String(last.content).slice(0, 400)}`, rawContent: '', toolCalls: [] };
      }
      const userText = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
      const available = new Set(input.tools.map((t) => t.name));
      const route = MOCK_ROUTES.find((r) => r.re.test(userText) && available.has(r.tool));
      if (route) {
        const args =
          route.tool === 'remember'
            ? { text: userText.replace(/^.*?(remember|note that|save)\s*/i, '').trim() || userText, kind: 'note' }
            : route.tool === 'recall' || route.tool === 'search_knowledge'
              ? { query: userText }
              : {};
        return { text: '', rawContent: '', toolCalls: [{ id: 'mock', name: route.tool, arguments: args }] };
      }
      return {
        text: `[mock] "${userText}" — load a QVAC model (drop --mock) for a real answer.`,
        rawContent: '',
        toolCalls: [],
      };
    },
  };
}

function mockEmbeddings(): EmbeddingProvider {
  // Tiny deterministic bag-of-words embedder over a Bitcoin vocab — enough to
  // demo RAG ranking without a model.
  const VOCAB = ['balance', 'inbound', 'liquidity', 'channel', 'swap', 'rgb', 'price', 'fee', 'seed', 'lightning', 'onchain', 'lsp', 'invoice', 'receive', 'send'];
  return {
    dimension: VOCAB.length,
    async embed(texts) {
      return texts.map((t) => {
        const l = t.toLowerCase();
        return VOCAB.map((w) => (l.match(new RegExp(w, 'g'))?.length ?? 0));
      });
    },
  };
}

// ── QVAC (real) ──────────────────────────────────────────────────────────────
async function qvacProvider(sdk: any, modelPath: string): Promise<LLMProvider> {
  const modelId: string = await sdk.loadModel({
    modelSrc: modelPath,
    modelType: 'llm',
    modelConfig: { ctx_size: 8192, tools: true },
  });
  return {
    name: 'qvac',
    async runTurn(input) {
      const history = input.system ? [{ role: 'system', content: input.system }, ...input.messages] : input.messages;
      const run: any = sdk.completion({
        modelId,
        history,
        stream: true,
        tools: input.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      });
      let streamed = '';
      for await (const ev of run.events) if (ev?.type === 'contentDelta') { streamed += ev.text; process.stdout.write(C.dim(ev.text)); }
      const final = await run.final;
      const raw = final?.contentText || streamed || '';
      return {
        text: raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim(),
        rawContent: final?.raw?.fullText ?? raw,
        toolCalls: (final?.toolCalls || []).map((c: any) => ({ id: c.id, name: c.name, arguments: c.arguments ?? {} })),
        requestId: run?.requestId,
      };
    },
  };
}

async function qvacEmbeddings(sdk: any): Promise<EmbeddingProvider> {
  const id: string = await sdk.loadModel({ modelSrc: sdk.GTE_LARGE_FP16, modelType: 'embeddings' });
  return {
    dimension: 1024,
    async embed(texts) {
      const out: number[][] = [];
      for (const text of texts) out.push((await sdk.embed({ modelId: id, text })).embedding);
      return out;
    },
  };
}

// ── Persistent memory (JSON file on disk) ─────────────────────────────────────
function fileMemoryIO(path: string): MemoryIO {
  return {
    load: async () => {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as MemoryItem[];
      } catch {
        return [];
      }
    },
    save: async (items) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(items, null, 2));
    },
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const wantMock = process.argv.includes('--mock');
  const wantRag = process.argv.includes('--rag');
  const modelPath = arg('--model') || process.env.QVAC_MODEL_PATH || join(homedir(), '.kaleido', 'models', 'Qwen3-0.6B-Q4_K_M.gguf');
  const mcpEntry = arg('--mcp') || process.env.KALEIDO_MCP_PATH;

  // Provider: QVAC if available, else mock.
  let provider: LLMProvider;
  let embeddings: EmbeddingProvider | null = null;
  let sdk: any = null;
  if (!wantMock) {
    try {
      sdk = await import('@qvac/sdk');
    } catch {
      console.error(C.yellow('⚠ @qvac/sdk not available — running in MOCK mode.'));
    }
  }
  if (sdk) {
    console.error(C.dim(`[loading ${modelPath}]`));
    provider = await qvacProvider(sdk, modelPath);
    if (wantRag) {
      console.error(C.dim('[loading GTE_LARGE_FP16 embeddings]'));
      embeddings = await qvacEmbeddings(sdk);
    }
  } else {
    provider = mockProvider();
    if (wantRag) embeddings = mockEmbeddings();
  }

  // Skills.
  const skills = new SkillRegistry(loadSkillsDir(packagedSkillsDir()));

  // Memory (persisted to ~/.kaleido/mind/memory.json).
  const memPath = join(homedir(), '.kaleido', 'mind', 'memory.json');
  const memory = new InMemoryMemoryStore({ io: fileMemoryIO(memPath) });

  // RAG (optional).
  let retriever: Retriever | null = null;
  if (embeddings) {
    retriever = new Retriever({ embeddings });
    const n = await retriever.ingest(BITCOIN_COPILOT_DOCS);
    console.error(C.dim(`[RAG: ingested ${n} chunks of Bitcoin knowledge]`));
  }

  // Tool registry: mock wallet/market tools (or kaleido-mcp) + memory + RAG.
  const sources: ToolSource[] = [];
  let mcp: any = null;
  if (mcpEntry && sdk) {
    try {
      const { McpToolSource } = await import('@kaleidorg/mind/mcp');
      mcp = new McpToolSource({ id: 'kaleido', transport: { kind: 'stdio', command: 'node', args: [mcpEntry] } });
      await mcp.connect();
      sources.push(mcp as ToolSource);
      console.error(C.dim(`[kaleido-mcp: ${mcp.listTools().length} tools]`));
    } catch (e) {
      console.error(C.yellow(`⚠ kaleido-mcp connect failed: ${(e as Error).message} — using mock tools`));
    }
  }
  if (!mcp) sources.push(new InProcessToolSource('mock-wallet', MOCK_TOOLS));
  sources.push(createMemoryToolSource(memory));
  if (retriever) sources.push(createRagToolSource(retriever));

  const tools = new ToolRegistry(sources);
  const builder = new ContextBuilder({ profile: PROFILE, memory, retriever: retriever ?? undefined, topKMemory: 3, budgetTokens: 2000 });

  // ── REPL ──
  const mode = sdk ? C.green('QVAC') : C.yellow('MOCK');
  console.log(`\n${C.violet('🧠 KaleidoMind CLI')}  ${C.dim(`[${mode} · ${skills.list().length} skills · ${retriever ? 'RAG on' : 'RAG off'}]`)}`);
  console.log(C.dim('Type a message, or /help for commands. Ctrl-D to exit.\n'));

  const history: Message[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdout.isTTY });
  const prompt = () => {
    if (process.stdout.isTTY) {
      rl.setPrompt(C.violet('🧠 > '));
      rl.prompt();
    }
  };

  async function handle(line: string): Promise<void> {
    const text = line.trim();
    if (!text) return;

    // Slash commands.
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(' ');
      const argStr = rest.join(' ').trim();
      switch (cmd) {
        case 'help':
          console.log(C.dim('  /skills  /mem  /forget  /ingest <text>  /search <q>  /reset  /quit'));
          break;
        case 'skills':
          for (const s of skills.list()) console.log(`  ${C.cyan(s.name)} — ${s.description.slice(0, 80)}`);
          break;
        case 'mem': {
          const items = await memory.all();
          if (!items.length) console.log(C.dim('  (memory empty)'));
          for (const m of items) console.log(`  ${C.dim(`(${m.kind})`)} ${m.text}`);
          break;
        }
        case 'forget':
          await memory.clear();
          console.log(C.dim('  memory cleared'));
          break;
        case 'ingest':
          if (!retriever) { console.log(C.yellow('  RAG is off — start with --rag')); break; }
          await retriever.ingest([{ text: argStr }]);
          console.log(C.dim('  ingested'));
          break;
        case 'search': {
          if (!retriever) { console.log(C.yellow('  RAG is off — start with --rag')); break; }
          const hits = await retriever.search(argStr, 3);
          for (const h of hits) console.log(`  ${C.dim(`(${h.score.toFixed(2)})`)} ${h.text.slice(0, 100)}`);
          break;
        }
        case 'reset':
          history.length = 0;
          console.log(C.dim('  conversation reset'));
          break;
        case 'quit':
        case 'exit':
          rl.close();
          return;
        default:
          console.log(C.yellow(`  unknown command: /${cmd}`));
      }
      return;
    }

    // Chat turn: route to a skill, compose context, run the agent.
    const skill = skills.select(text);
    const { system: skillSystem, allowedTools } = skills.compose('', skill);
    const { system } = await builder.build({ query: text, skillSystem });
    if (skill) console.log(C.dim(`  ↳ skill: ${skill.name}`));

    // Keep cross-cutting tools (memory + knowledge) reachable even when a
    // tool-scoped skill is active — they aren't part of any one skill.
    const effectiveAllowed = allowedTools
      ? [...new Set([...allowedTools, ...AMBIENT_TOOLS])]
      : undefined;

    const engine = new Engine({ provider, tools, defaultSystem: system, defaultMaxTurns: 6 });
    try {
      const res = await engine.runAgentic([...history, { role: 'user', content: text }], {
        allowedTools: effectiveAllowed,
        onToolCall: (c) => console.log(C.cyan(`  🔧 ${c.name}(${JSON.stringify(c.arguments).slice(0, 60)})`)),
        onConfirm: async (c) => { console.log(C.yellow(`  ⚠ auto-approving ${c.name} (cli)`)); return { approved: true }; },
      });
      console.log(`${C.green('🤖')} ${res.text || '(no text)'}\n`);
      history.push({ role: 'user', content: text }, { role: 'assistant', content: res.text });
    } catch (e) {
      console.log(C.yellow(`  error: ${(e as Error).message}\n`));
    }
  }

  prompt();
  for await (const line of rl) {
    await handle(line);
    prompt();
  }

  if (sdk?.close) await sdk.close();
}

main().catch((e) => {
  console.error('cli error:', e);
  process.exit(1);
});
