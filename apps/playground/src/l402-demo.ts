/**
 * L402 agentic workflow demo — the headline differentiator.
 *
 * Spins up a local L402-paywalled "premium price" endpoint, then asks the
 * agent to fetch it. The agent calls `fetch_paid_resource`, hits a 402, the
 * L402 tool pays the Lightning invoice (mock wallet here; real wallet on
 * device), retries with the token, and reports the price — all autonomously,
 * fully local.
 *
 *   pnpm --filter @kaleidorg/mind-playground exec tsx src/l402-demo.ts
 *   QVAC_MODEL_PATH=~/.kaleido/models/Qwen3-4B-Q4_K_M.gguf pnpm ... l402-demo.ts
 */

import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  Engine,
  ToolRegistry,
  createL402ToolSource,
  type LLMProvider,
} from '@kaleidorg/mind';

const MODEL_PATH =
  process.env.QVAC_MODEL_PATH ||
  join(homedir(), '.kaleido', 'models', 'Qwen3-0.6B-Q4_K_M.gguf');

async function startMockL402Server(): Promise<{ url: string; close: () => void; paidCount: () => number }> {
  let paid = 0;
  const server = createServer((req, res) => {
    if (!req.url?.startsWith('/premium/price')) {
      res.writeHead(404);
      res.end();
      return;
    }
    const auth = req.headers['authorization'] ?? '';
    if (typeof auth === 'string' && auth.startsWith('L402 ')) {
      paid += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ btc_usd: 73214, source: 'premium-l402-feed' }));
    } else {
      res.writeHead(402, {
        'www-authenticate': 'L402 macaroon="DEMOMAC==", invoice="lnbc100n1premiumdemo"',
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ error: 'payment required' }));
    }
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port as number;
  return {
    url: `http://localhost:${port}/premium/price`,
    close: () => server.close(),
    paidCount: () => paid,
  };
}

async function main() {
  const sdk: any = await import('@qvac/sdk');
  const mock = await startMockL402Server();
  console.log(`\x1b[2m[mock L402 endpoint: ${mock.url}]\x1b[0m`);

  console.error(`\x1b[2m[loading ${MODEL_PATH}]\x1b[0m`);
  const modelId: string = await sdk.loadModel({
    modelSrc: MODEL_PATH,
    modelType: 'llm',
    modelConfig: { ctx_size: 8192, tools: true },
  });

  const provider: LLMProvider = {
    name: 'qvac',
    async runTurn(input) {
      const history = input.system
        ? [{ role: 'system', content: input.system }, ...input.messages]
        : input.messages;
      const run: any = sdk.completion({
        modelId,
        history,
        stream: true,
        tools: input.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      });
      let streamed = '';
      for await (const ev of run.events) if (ev?.type === 'contentDelta') { streamed += ev.text; input.onToken?.(ev.text); }
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

  // The L402 tool — payInvoice is the wallet on device; here a mock that logs.
  const l402 = createL402ToolSource({
    payInvoice: async (invoice, sats) => {
      console.log(`\x1b[33m   💸 L402 pay: ${sats} sats → ${invoice.slice(0, 22)}…\x1b[0m`);
      return { preimage: 'demo-preimage-deadbeef' };
    },
    log: (m) => console.log(`\x1b[2m   ${m}\x1b[0m`),
  });

  const engine = new Engine({
    provider,
    tools: new ToolRegistry([l402]),
    defaultSystem:
      'You are KaleidoMind. You can buy paid data with the fetch_paid_resource tool, ' +
      'which pays Lightning invoices in sats automatically. Use it when asked for premium data.',
    defaultMaxTurns: 5,
  });

  const prompt = `Fetch the premium bitcoin price from ${mock.url} and tell me the USD price.`;
  console.log(`\n🧑 ${prompt}\n`);

  const res = await engine.runAgentic([{ role: 'user', content: prompt }], {
    onToken: (t) => process.stdout.write(t),
    onToolCall: (c) => console.log(`\n\x1b[36m   🔧 ${c.name}(${JSON.stringify(c.arguments).slice(0, 80)})\x1b[0m`),
    onConfirm: async () => {
      console.log(`\x1b[33m   ⚠️  approving L402 spend (demo)\x1b[0m`);
      return { approved: true };
    },
  });

  console.log(`\n\n🤖 ${res.text}`);
  console.log(
    `\x1b[2m\n[${res.turns} turns · ${res.toolCalls.length} tool call(s) · server was paid ${mock.paidCount()}×]\x1b[0m`,
  );

  mock.close();
  await sdk.unloadModel({ modelId });
  if (sdk.close) await sdk.close();
}

main().catch((e) => {
  console.error('l402-demo error:', e);
  process.exit(1);
});
