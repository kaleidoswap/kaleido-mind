/**
 * Function-calling benchmark for a single GGUF model.
 *
 *   pnpm --filter @kaleidorg/mind-bench start -- /path/to/model.gguf [label]
 *
 * Scores, on a wallet tool-calling eval set:
 *   - tool selection accuracy (right tool, or correctly NO tool)
 *   - param following (by VALUE — small models vary arg names, so we check the
 *     actual recipient/amount landed, not the exact key)
 *   - first-call latency
 * Writes results/<label>.json and prints a summary.
 */

import { homedir } from 'node:os';
import { basename, join, dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MODEL_PATH = process.argv[2] || process.env.QVAC_MODEL_PATH;
const LABEL = process.argv[3] || (MODEL_PATH ? basename(MODEL_PATH).replace(/\.gguf$/, '') : 'model');
if (!MODEL_PATH) {
  console.error('usage: bench <model.gguf> [label]');
  process.exit(1);
}

// Tool schemas (same as the playground / mobile wallet surface).
const TOOLS = [
  { name: 'get_balance', description: 'Get the wallet BTC balance in satoshis.', parameters: { type: 'object', properties: {} } },
  { name: 'get_address', description: 'Get a fresh BTC address to receive funds.', parameters: { type: 'object', properties: {} } },
  {
    name: 'list_transactions',
    description: 'List recent wallet transactions.',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } },
  },
  {
    name: 'pay_invoice',
    description: 'Pay a Lightning invoice or address.',
    parameters: {
      type: 'object',
      properties: { invoice_or_address: { type: 'string' }, amount_sats: { type: 'number' } },
      required: ['invoice_or_address'],
    },
  },
];

interface EvalCase {
  prompt: string;
  expectTool: string | null; // null = should NOT call a tool
  expectValues?: string[]; // substrings that should appear in the args (by value)
}

const EVAL: EvalCase[] = [
  { prompt: "What's my balance?", expectTool: 'get_balance' },
  { prompt: 'How much bitcoin do I have right now?', expectTool: 'get_balance' },
  { prompt: 'Give me an address to receive some sats', expectTool: 'get_address' },
  { prompt: 'I need a deposit address', expectTool: 'get_address' },
  { prompt: 'Show my last 3 transactions', expectTool: 'list_transactions', expectValues: ['3'] },
  { prompt: 'What are my recent payments?', expectTool: 'list_transactions' },
  { prompt: 'Pay 5000 sats to alice@getalby.com', expectTool: 'pay_invoice', expectValues: ['alice@getalby.com', '5000'] },
  { prompt: 'Send 1200 sats to lnbc1examplexyz', expectTool: 'pay_invoice', expectValues: ['lnbc1examplexyz', '1200'] },
  { prompt: 'What is the Lightning Network, in one sentence?', expectTool: null },
  { prompt: 'Tell me a fun fact about Bitcoin', expectTool: null },
];

interface CaseResult {
  prompt: string;
  expectTool: string | null;
  calledTool: string | null;
  toolCorrect: boolean;
  paramCorrect: boolean | null; // null when no values expected
  latencyMs: number;
}

async function main() {
  const sdk: any = await import('@qvac/sdk');
  console.error(`\x1b[2m[${LABEL}] loading ${MODEL_PATH}\x1b[0m`);
  const modelId: string = await sdk.loadModel({
    modelSrc: MODEL_PATH,
    modelType: 'llm',
    modelConfig: { ctx_size: 8192, tools: true },
  });
  console.error(`\x1b[2m[${LABEL}] loaded — running ${EVAL.length} cases\x1b[0m`);

  const SYSTEM =
    'You are a Bitcoin and Lightning wallet assistant. Use the available tools to take actions. ' +
    'Only call a tool when the user is asking about their wallet; for general questions, just answer.';

  const results: CaseResult[] = [];

  for (const c of EVAL) {
    const t0 = Date.now();
    const run: any = sdk.completion({
      modelId,
      history: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: c.prompt },
      ],
      stream: true,
      tools: TOOLS,
    });
    // drain stream
    for await (const _ of run.events) { /* ignore tokens */ }
    const final = await run.final;
    const latencyMs = Date.now() - t0;

    const calls = final?.toolCalls ?? [];
    const calledTool: string | null = calls[0]?.name ?? null;

    const toolCorrect = c.expectTool === null ? calls.length === 0 : calledTool === c.expectTool;

    let paramCorrect: boolean | null = null;
    if (c.expectValues && calls[0]) {
      const argStr = JSON.stringify(calls[0].arguments ?? {}).toLowerCase();
      paramCorrect = c.expectValues.every((v) => argStr.includes(v.toLowerCase()));
    }

    results.push({ prompt: c.prompt, expectTool: c.expectTool, calledTool, toolCorrect, paramCorrect, latencyMs });
    const mark = toolCorrect ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const pmark = paramCorrect === null ? ' ' : paramCorrect ? '\x1b[32mp\x1b[0m' : '\x1b[31mp\x1b[0m';
    console.error(`  ${mark}${pmark} ${c.expectTool ?? '(none)'} ← "${c.prompt.slice(0, 42)}" (${latencyMs}ms, got ${calledTool ?? 'none'})`);
  }

  const toolAcc = results.filter((r) => r.toolCorrect).length / results.length;
  const paramCases = results.filter((r) => r.paramCorrect !== null);
  const paramAcc = paramCases.length ? paramCases.filter((r) => r.paramCorrect).length / paramCases.length : null;
  const avgLatency = Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / results.length);

  const summary = {
    label: LABEL,
    model: basename(MODEL_PATH!),
    cases: results.length,
    toolAccuracy: Number(toolAcc.toFixed(3)),
    paramAccuracy: paramAcc === null ? null : Number(paramAcc.toFixed(3)),
    avgLatencyMs: avgLatency,
    results,
  };

  // write results next to this package
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, '..', 'results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${LABEL}.json`), JSON.stringify(summary, null, 2));

  console.log(
    `\n\x1b[1m${LABEL}\x1b[0m  tool ${(toolAcc * 100).toFixed(0)}%` +
      (paramAcc !== null ? ` · params ${(paramAcc * 100).toFixed(0)}%` : '') +
      ` · ${avgLatency}ms/call → results/${LABEL}.json`,
  );

  await sdk.unloadModel({ modelId });
  if (sdk.close) await sdk.close();
}

main().catch((e) => {
  console.error('bench error:', e);
  process.exit(1);
});

// keep homedir import used (default path hint in errors)
void homedir;
