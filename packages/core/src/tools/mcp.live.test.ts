/**
 * Live MCP integration — regression guard for the "tool-less desktop chat" bug.
 *
 * The desktop agent (desktop-app/src-tauri/src/mind.rs → apps/provider
 * connectMcpIfConfigured) wires tools EXACTLY the way this test does: spawn
 * `node <kaleido-mcp>/dist/index.js` over stdio with RLN_NODE_URL pointing at
 * the user's RGB-Lightning node, then listTools()/execute(). When that wiring
 * breaks, the registry is empty, the model goes "tool-less", and it NARRATES
 * tool calls it can never run ("Could you use the kaleidoswap_get_quote tool?")
 * instead of returning real data — the exact 2026-06 symptom.
 *
 * This drives that chain end-to-end against a REAL running node and asserts the
 * tools both EXIST (not tool-less) and EXECUTE (return live node data). A unit
 * test can't catch this: the bug is in process/env wiring, not pure logic.
 *
 * Auto-skips unless (a) kaleido-mcp/dist is built and (b) an RLN node answers,
 * so it's a no-op in CI and a real check on a dev box with a node up. Run it
 * explicitly against a node with:
 *   RLN_NODE_URL=http://localhost:3001 pnpm --filter @kaleidorg/mind test:live
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpToolSource } from './mcp.js';

const here = dirname(fileURLToPath(import.meta.url));
// $KALEIDO_MCP_PATH override (what mind.rs sets), else the sibling repo's build.
const MCP_ENTRY =
  process.env.KALEIDO_MCP_PATH ??
  resolve(here, '../../../../../kaleido-mcp/dist/index.js');
const NODE_URL = (process.env.RLN_NODE_URL ?? 'http://localhost:3001').replace(/\/+$/, '');

/** Probe the RLN node directly so we can (a) gate the suite and (b) compare the
 *  MCP tool's output to ground truth pulled straight from the node. */
async function fetchNodePubkey(): Promise<string | null> {
  try {
    const r = await fetch(`${NODE_URL}/nodeinfo`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { pubkey?: string };
    return typeof j.pubkey === 'string' && j.pubkey.length > 0 ? j.pubkey : null;
  } catch {
    return null;
  }
}

const hasDist = existsSync(MCP_ENTRY);
const livePubkey = hasDist ? await fetchNodePubkey() : null;
const RUN = hasDist && !!livePubkey;

if (!RUN) {
  const why = !hasDist ? `no built MCP at ${MCP_ENTRY}` : `no RLN node at ${NODE_URL}`;
  // eslint-disable-next-line no-console
  console.warn(`[mcp.live] skipping live MCP integration — ${why}`);
}

describe.skipIf(!RUN)('MCP live integration (real RLN node)', () => {
  let src: McpToolSource;

  beforeAll(async () => {
    src = new McpToolSource({
      id: 'kaleido-test',
      transport: {
        kind: 'stdio',
        command: 'node',
        args: [MCP_ENTRY],
        // Mirror the provider: inherit env, force the node URL, allow no WDK seed
        // (rln_*/kaleidoswap_* register regardless; only spark_*/wdk_* need it).
        env: {
          ...process.env,
          RLN_NODE_URL: NODE_URL,
          WDK_SEED: process.env.WDK_SEED ?? '',
        } as Record<string, string>,
      },
      timeoutMs: 30_000,
    });
    await src.connect();
  }, 45_000);

  afterAll(async () => {
    await src?.close();
  });

  it('exposes a non-empty tool registry (the model is NOT tool-less)', () => {
    const tools = src.listTools();
    expect(tools.length).toBeGreaterThan(0);
    // The exact tools the agent narrated when it couldn't call them.
    expect(src.has('rln_get_node_info')).toBe(true);
    expect(src.has('rln_get_balances')).toBe(true);
    expect(src.has('kaleidoswap_get_quote')).toBe(true);
  });

  it('preserves the confirmation gate on known spend tools', () => {
    const spend = src.listTools().find((tool) => tool.name === 'rln_pay_invoice');
    if (spend) expect(spend.requiresConfirmation).toBe(true);
  });

  it('rln_get_node_info EXECUTES against the node (returns the live pubkey)', async () => {
    const out = await src.execute('rln_get_node_info', {});
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    // Real execution returns the node's actual identity — not a narrated promise.
    expect(text).toContain(livePubkey!);
  }, 30_000);

  it('rln_get_balances EXECUTES against the node (returns live balance fields)', async () => {
    const out = await src.execute('rln_get_balances', {});
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    const parsed = JSON.parse(text) as {
      lightning_balance_sat?: number;
      btc_onchain?: Record<string, number>;
    };
    expect(parsed).toHaveProperty('lightning_balance_sat');
    expect(typeof parsed.lightning_balance_sat).toBe('number');
    expect(parsed).toHaveProperty('btc_onchain');
  }, 30_000);
});
