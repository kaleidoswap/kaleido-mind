/**
 * KaleidoMind playground — exercise the engine + tools against a REAL local
 * QVAC model, with no phone and no MCP server. The fastest way to answer
 * "does the model actually call the tools correctly?".
 *
 *   pnpm play "what's my balance?"
 *   QVAC_MODEL_PATH=/path/to/model.gguf pnpm play "pay alice 5000 sats"
 *
 * Tools here return mock data so we can test the model's tool-calling
 * competence in isolation. Swap the ToolSource for kaleido-mcp (desktop) or
 * the real wallet adapters (mobile) and the engine behaves identically.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import {
  Engine,
  ToolRegistry,
  InProcessToolSource,
  TurnLogger,
  defaultMask,
  type LLMProvider,
  type InProcessTool,
  type LoggerIO,
} from '@kaleidorg/mind';

// Node IO for the dataset logger — writes masked JSONL turn records.
const loggerIO: LoggerIO = {
  async ensureDir(p) {
    await fsp.mkdir(p, { recursive: true });
  },
  async appendLine(file, line) {
    await fsp.appendFile(file, line);
  },
  hash(v) {
    return createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
  },
  now() {
    return new Date();
  },
};

const MODEL_PATH =
  process.env.QVAC_MODEL_PATH ||
  join(homedir(), '.kaleido', 'models', 'Qwen3-0.6B-Q4_K_M.gguf');

// ── Demo wallet tools (mock data) ──────────────────────────────────────
const demoTools: InProcessTool[] = [
  {
    name: 'get_balance',
    description: 'Get the wallet BTC balance in satoshis.',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ sats: 124_000, confirmed: 120_000, pending: 4_000 }),
  },
  {
    name: 'get_address',
    description: 'Get a fresh BTC address to receive funds.',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ address: 'bc1qdemoaddressforplaygroundtesting' }),
  },
  {
    name: 'list_transactions',
    description: 'List recent wallet transactions.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'how many to return' } },
    },
    handler: async (a: Record<string, unknown>) => ({
      transactions: [
        { amount_sats: 5000, direction: 'received', status: 'confirmed' },
        { amount_sats: 1200, direction: 'sent', status: 'confirmed' },
        { amount_sats: 30000, direction: 'received', status: 'confirmed' },
      ].slice(0, Number(a.limit) || 5),
    }),
  },
  {
    name: 'pay_invoice',
    description: 'Pay a Lightning invoice or address.',
    parameters: {
      type: 'object',
      properties: {
        invoice_or_address: { type: 'string' },
        amount_sats: { type: 'number' },
      },
      required: ['invoice_or_address'],
    },
    requiresConfirmation: true,
    handler: async (a: Record<string, unknown>) => ({
      paid: true,
      to: a.invoice_or_address,
      amount_sats: a.amount_sats ?? 0,
      preimage: 'demo-preimage',
    }),
  },
];

async function main() {
  const prompt = process.argv.slice(2).join(' ') || 'What is my balance?';

  // @qvac/sdk runs in Node here exactly as in the desktop sidecar.
  const sdk: any = await import('@qvac/sdk');

  console.error(`\x1b[2m[loading ${MODEL_PATH}]\x1b[0m`);
  const modelId: string = await sdk.loadModel({
    modelSrc: MODEL_PATH,
    modelType: 'llm',
    // `tools: true` enables the llamacpp tool-calling grammar — without it the
    // model just talks about tools instead of emitting structured calls.
    modelConfig: { ctx_size: 8192, tools: true },
  });
  console.error('\x1b[2m[model loaded]\x1b[0m');

  const provider: LLMProvider = {
    name: 'qvac',
    async runTurn(input) {
      const history = input.system
        ? [{ role: 'system', content: input.system }, ...input.messages]
        : input.messages;
      const toolDefs = input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
      const run: any = sdk.completion({
        modelId,
        history,
        stream: true,
        tools: toolDefs.length ? toolDefs : undefined,
      });
      let streamed = '';
      for await (const ev of run.events) {
        if (ev?.type === 'contentDelta') {
          streamed += ev.text;
          input.onToken?.(ev.text);
        }
      }
      const final = await run.final;
      const raw = final?.contentText || streamed || '';
      const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      return {
        text,
        rawContent: final?.raw?.fullText ?? raw,
        toolCalls: (final?.toolCalls || []).map((c: any) => ({
          id: c.id,
          name: c.name,
          arguments: c.arguments ?? {},
        })),
        requestId: run?.requestId,
      };
    },
  };

  const engine = new Engine({
    provider,
    tools: new ToolRegistry([new InProcessToolSource('wallet', demoTools)]),
    defaultSystem:
      'You are KaleidoMind, a Bitcoin and Lightning wallet assistant. ' +
      'Use the available tools to answer; never invent balances, addresses or amounts — ' +
      'always call a tool and report what it returns. Keep replies short.',
    defaultMaxTurns: 6,
  });

  console.log(`\n🧑 ${prompt}\n`);
  const res = await engine.runAgentic([{ role: 'user', content: prompt }], {
    onToken: (t) => process.stdout.write(t),
    onToolCall: (c) => console.log(`\n\x1b[36m  🔧 ${c.name}(${JSON.stringify(c.arguments)})\x1b[0m`),
    onConfirm: async (c) => {
      console.log(`\x1b[33m  ⚠️  confirm ${c.name} → auto-approving (demo)\x1b[0m`);
      return { approved: true };
    },
  });

  console.log(`\n\n🤖 ${res.text}`);
  console.log(`\x1b[2m\n[${res.turns} turns · ${res.toolCalls.length} tool call(s): ${res.toolCalls
    .map((c) => c.name)
    .join(', ')}]\x1b[0m`);

  // Capture a masked, APIGen-MT-compatible turn record for the fine-tune corpus.
  const logsDir = join(homedir(), '.kaleido', 'mind', 'logs');
  const logger = new TurnLogger({ dir: logsDir, device: 'playground', io: loggerIO, mask: defaultMask(loggerIO) });
  const sessionId = `play-${loggerIO.hash(prompt).slice(0, 8)}`;
  await logger.log({
    session_id: sessionId,
    model: { provider: 'qvac', name: MODEL_PATH.split('/').pop() ?? 'unknown' },
    system_hash: loggerIO.hash('system'),
    tools: demoTools.map((t) => ({ name: t.name, schema_hash: loggerIO.hash(t.parameters) })),
    messages: res.messages,
    decision: {
      tool_calls: res.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
      final_text: res.text,
    },
    results: res.toolCalls,
    latency_ms: { reason: res.latencyMs, total: res.latencyMs },
  });
  console.log(`\x1b[2m[logged → ${logsDir}/<date>/session-${sessionId}.jsonl]\x1b[0m`);

  await sdk.unloadModel({ modelId });
  if (sdk.close) await sdk.close();
}

main().catch((e) => {
  console.error('Playground error:', e);
  process.exit(1);
});
