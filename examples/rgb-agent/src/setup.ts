/** Tool and model setup shared by the agent (index.ts) and the eval (eval.ts). */
import { bindWalletTools, type LLMProvider, type ToolSource } from '@kaleidorg/mind';
import { McpToolSource } from '@kaleidorg/mind/mcp';
import { createQvacProvider } from '@kaleidorg/mind/qvac';
import { MockWallet } from '@kaleidorg/mind/testing';

/** kaleido-mcp over stdio (signet by default), or an in-process fake RLN node. */
export async function createTools(opts: {
  mock: boolean;
  allow: string[];
}): Promise<{ source: ToolSource; close: () => Promise<void> }> {
  if (opts.mock) {
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
    allow: opts.allow,
  });
  await mcp.connect();
  return { source: mcp, close: () => mcp.close() };
}

/** Load a Qwen3.5 model through @qvac/sdk. `model` is an @qvac/sdk constant name. */
export async function loadQvacProvider(
  model = 'QWEN3_5_4B_MULTIMODAL_Q4_K_M',
): Promise<{ provider: LLMProvider; dispose: () => Promise<void> }> {
  const sdk = await import('@qvac/sdk');
  const modelSrc = (sdk as unknown as Record<string, unknown>)[model];
  if (!modelSrc) throw new Error(`@qvac/sdk has no model constant ${model}`);
  console.error(`[loading ${model} — the first run downloads it]`);
  const modelId = await sdk.loadModel({ modelSrc: modelSrc as typeof sdk.QWEN3_5_4B_MULTIMODAL_Q4_K_M, modelConfig: { ctx_size: 8192, tools: true } });
  return {
    provider: createQvacProvider({
      completion: sdk.completion,
      cancel: sdk.cancel,
      getModelId: () => modelId,
      defaultTemperature: 0.1,
      defaultMaxTokens: 512,
      // Qwen3.5 ignores /no_think; this budget is what keeps a turn from
      // spending every token on reasoning.
      maxThinkingTokens: Number(process.env.THINK ?? 128),
    }),
    dispose: async () => {
      await sdk.unloadModel({ modelId });
      await sdk.close();
    },
  };
}
