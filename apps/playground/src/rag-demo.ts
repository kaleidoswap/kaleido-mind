/**
 * QVAC RAG demo — fully on-device retrieval-augmented generation.
 *
 * Mandatory for the QVAC hackathon: *all* inference AND RAG run through the
 * QVAC SDK. Here:
 *   - QVAC `embed()` (GTE_LARGE_FP16, 1024-dim) produces the vectors —
 *     wrapped as an `EmbeddingProvider`.
 *   - `@kaleidorg/mind` `Retriever` + `InMemoryVectorStore` are the
 *     "bring-your-own vector DB" (QVAC ships embeddings, not a store).
 *   - QVAC `completion()` answers the question using ONLY the retrieved
 *     context — no cloud, no data leaving the device.
 *
 *   QVAC_EMBED_MODEL=GTE_LARGE_FP16 \
 *   QVAC_MODEL_PATH=~/.kaleido/models/Qwen3-4B-Q4_K_M.gguf \
 *   pnpm --filter @kaleidorg/mind-playground exec tsx src/rag-demo.ts
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  Engine,
  ToolRegistry,
  Retriever,
  ContextBuilder,
  type EmbeddingProvider,
  type LLMProvider,
  type AgentProfile,
} from '@kaleidorg/mind';

const MODEL_PATH =
  process.env.QVAC_MODEL_PATH ||
  join(homedir(), '.kaleido', 'models', 'Qwen3-0.6B-Q4_K_M.gguf');

// A small on-brand corpus — the "Bitcoin copilot" knowledge base. In the real
// app this would be the KaleidoSwap docs, BOLT/RGB specs, the user's notes, …
const KNOWLEDGE: { id: string; text: string }[] = [
  {
    id: 'inbound-liquidity',
    text:
      'To RECEIVE Lightning payments you need inbound liquidity: remote balance ' +
      'on a channel pointing at you. New wallets have none. On KaleidoSwap you ' +
      'buy inbound liquidity from the LSP via an LSPS1 channel order — pick a ' +
      'capacity, pay the fee, and the LSP opens a channel giving you receive ' +
      'capacity instantly (0-conf supported).',
  },
  {
    id: 'submarine-swap',
    text:
      'A submarine swap moves value between on-chain Bitcoin and Lightning ' +
      'atomically using an HTLC. Send on-chain BTC and receive it on Lightning ' +
      '(or vice-versa) without a custodian. KaleidoSwap uses HTLC atomic swaps ' +
      'for its 5-step taker flow.',
  },
  {
    id: 'rgb-assets',
    text:
      'RGB is a protocol for issuing assets (like USDT and XAUT) on top of ' +
      'Bitcoin and Lightning, with validation kept client-side for privacy and ' +
      'scalability. On KaleidoSwap you can hold and swap RGB assets inside ' +
      'Lightning channels (colored channels).',
  },
  {
    id: 'channel-vs-onchain',
    text:
      'A Lightning channel is a 2-of-2 funding output that lets two peers send ' +
      'instant, cheap payments off-chain. On-chain transactions settle directly ' +
      'on Bitcoin: slower and with miner fees, but no channel needed. Use ' +
      'Lightning for fast spending, on-chain for settlement and channel funding.',
  },
  {
    id: 'rebalance',
    text:
      'Rebalancing moves liquidity so you keep both inbound (to receive) and ' +
      'outbound (to send) capacity. If you can send but not receive, you lack ' +
      'inbound liquidity; buy a channel from the LSP or receive an on-chain ' +
      'deposit and swap it into a channel.',
  },
];

/** QVAC embeddings wrapped as an EmbeddingProvider — the mandatory QVAC RAG bit. */
function qvacEmbeddingProvider(sdk: any, embedModelId: string): EmbeddingProvider {
  return {
    dimension: 1024, // GTE_LARGE_FP16
    async embed(texts: string[]): Promise<number[][]> {
      const out: number[][] = [];
      for (const text of texts) {
        const res = await sdk.embed({ modelId: embedModelId, text });
        out.push(res.embedding as number[]);
      }
      return out;
    },
  };
}

async function main() {
  const sdk: any = await import('@qvac/sdk');

  // 1. Load the QVAC embeddings model (GTE_LARGE_FP16 by default).
  const embedSrc = process.env.QVAC_EMBED_MODEL
    ? (sdk as any)[process.env.QVAC_EMBED_MODEL] ?? process.env.QVAC_EMBED_MODEL
    : sdk.GTE_LARGE_FP16;
  console.error('\x1b[2m[loading QVAC embeddings model…]\x1b[0m');
  const embedModelId: string = await sdk.loadModel({
    modelSrc: embedSrc,
    modelType: 'embeddings',
  });
  const embeddings = qvacEmbeddingProvider(sdk, embedModelId);

  // 2. Ingest the corpus into the local vector store (BYO DB — in-memory cosine).
  const retriever = new Retriever({ embeddings });
  const n = await retriever.ingest(KNOWLEDGE);
  console.error(`\x1b[2m[ingested ${n} chunks from ${KNOWLEDGE.length} docs]\x1b[0m`);

  // 3. Load the QVAC LLM for generation.
  console.error(`\x1b[2m[loading ${MODEL_PATH}]\x1b[0m`);
  const modelId: string = await sdk.loadModel({
    modelSrc: MODEL_PATH,
    modelType: 'llm',
    modelConfig: { ctx_size: 8192 },
  });

  const provider: LLMProvider = {
    name: 'qvac',
    async runTurn(input) {
      const history = input.system
        ? [{ role: 'system', content: input.system }, ...input.messages]
        : input.messages;
      const run: any = sdk.completion({ modelId, history, stream: true });
      let streamed = '';
      for await (const ev of run.events) if (ev?.type === 'contentDelta') streamed += ev.text;
      const final = await run.final;
      const raw = final?.contentText || streamed || '';
      return { text: raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim(), rawContent: raw, toolCalls: [] };
    },
  };

  // 4. Build the system prompt with retrieved context (ContextBuilder auto-RAG).
  const profile: AgentProfile = {
    name: 'KaleidoMind',
    soul: 'A private, on-device Bitcoin copilot. Answer ONLY from the provided context; if it is not there, say you are not sure.',
  };
  const builder = new ContextBuilder({ profile, retriever, topKRag: 3, budgetTokens: 4000 });

  const question =
    process.argv.slice(2).join(' ') ||
    'I can send sats but not receive them. What do I do?';
  console.log(`\n🧑 ${question}\n`);

  const { system } = await builder.build({ query: question });
  const hits = await retriever.search(question, 3);
  console.log(`\x1b[2m   ↳ retrieved: ${hits.map((h) => h.id.split('#')[0]).join(', ')}\x1b[0m\n`);

  const engine = new Engine({ provider, tools: new ToolRegistry([]), defaultSystem: system });
  const res = await engine.runAgentic([{ role: 'user', content: question }]);

  console.log(`🤖 ${res.text}\n`);
  console.log(`\x1b[2m[fully on-device · QVAC embeddings + QVAC completion · no cloud]\x1b[0m`);

  await sdk.unloadModel({ modelId });
  await sdk.unloadModel({ modelId: embedModelId });
  if (sdk.close) await sdk.close();
}

main().catch((e) => {
  console.error('rag-demo error:', e);
  process.exit(1);
});
