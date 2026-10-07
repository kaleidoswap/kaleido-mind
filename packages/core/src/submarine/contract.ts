/**
 * Canonical submarine-swap tool contract — pay a Lightning invoice from Liquid
 * funds through the KaleidoSwap Boltz /v2 maker (kaleidoswap-maker-rs).
 *
 * The names match kaleido-mcp, which implements them over @kaleidorg/swap-sdk.
 * Hosts with the SDK in-process (desktop sidecar, React Native) bind the same
 * names with `bindSubmarineTools`.
 *
 * Keys and preimages never cross this contract: the host derives the refund key
 * from its wallet mnemonic and persists the swap. `kaleidoswap_submarine_fund`
 * — the only spend — takes nothing but the swap id, so the model cannot alter
 * the amount, asset or lockup address it pays.
 *
 * Pure data — no deps, no fetch, RN-safe.
 */

import type { ToolDef } from '../types.js';
import { InProcessToolSource } from '../tools/in-process.js';
import type { InProcessTool } from '../tools/in-process.js';

export interface SubmarineToolDef extends ToolDef {
  /** Moves funds → confirmation-gated. */
  spend?: boolean;
}

type Props = Record<string, { type: string; description?: string; enum?: string[] }>;

function t(name: string, description: string, properties: Props = {}, required: string[] = [], spend = false): SubmarineToolDef {
  return { name, description, spend, requiresConfirmation: spend, parameters: { type: 'object', properties, required } };
}

/** Assets a submarine swap can be paid from, as the maker names them. */
export const SUBMARINE_FROM_ASSETS = ['L-USDT', 'L-BTC'] as const;
export type SubmarineFromAsset = typeof SUBMARINE_FROM_ASSETS[number];

/** Smallest-unit decimals of each source asset (L-USDT: 8, L-BTC: sats). */
export const SUBMARINE_ASSET_DECIMALS: Record<SubmarineFromAsset, number> = { 'L-USDT': 8, 'L-BTC': 8 };

const swapId = { type: 'string', description: 'Swap id returned by kaleidoswap_submarine_create' } as const;

export const SUBMARINE_TOOLS: SubmarineToolDef[] = [
  t('kaleidoswap_submarine_pairs',
    'List what can pay a Lightning invoice through a submarine swap (e.g. L-USDT on Liquid → Lightning BTC): rate, min/max, fees. No args.'),

  t('kaleidoswap_submarine_create',
    'Open a submarine swap that pays a Lightning (BOLT11) invoice from Liquid funds. No funds move: returns swap_id and expected_amount (source asset smallest unit). Then confirm with the user and call kaleidoswap_submarine_fund.',
    {
      invoice:    { type: 'string', description: 'BOLT11 Lightning invoice to pay (must carry an amount)' },
      from_asset: { type: 'string', enum: [...SUBMARINE_FROM_ASSETS], description: 'Asset to pay with (default L-USDT)' },
    },
    ['invoice']),

  t('kaleidoswap_submarine_fund',
    'SPEND: lock the funds for a swap from kaleidoswap_submarine_create. Takes only the swap id — amount, asset and address come from the stored swap. The maker then pays the invoice.',
    { swap_id: swapId },
    ['swap_id'],
    /* spend */ true),

  t('kaleidoswap_submarine_status',
    'Status of a submarine swap. "transaction.claimed" = invoice paid, done. A failed funded swap needs a refund.',
    { swap_id: swapId },
    ['swap_id']),
];

export const SUBMARINE_SPEND_TOOLS: Set<string> = new Set(SUBMARINE_TOOLS.filter((d) => d.spend).map((d) => d.name));

export function isSubmarineSpendTool(name: string): boolean {
  return SUBMARINE_SPEND_TOOLS.has(name);
}

export function getSubmarineTool(name: string): SubmarineToolDef | undefined {
  return SUBMARINE_TOOLS.find((d) => d.name === name);
}

/** Format a smallest-unit amount of a source asset for display ("52.3 L-USDT", "1,200 sats"). */
export function formatSubmarineAmount(asset: string, smallestUnits: unknown): string {
  const n = Number(smallestUnits);
  if (!Number.isFinite(n)) return `${String(smallestUnits)} ${asset}`;
  if (asset === 'L-BTC') return `${n.toLocaleString('en-US')} sats of L-BTC`;
  const decimals = SUBMARINE_ASSET_DECIMALS[asset as SubmarineFromAsset] ?? 0;
  const value = n / 10 ** decimals;
  return `${value.toLocaleString('en-US', { maximumFractionDigits: decimals })} ${asset}`;
}

export type SubmarineHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface BindSubmarineOptions {
  /** Skip tools without a handler instead of throwing (default false). */
  allowMissing?: boolean;
  /** ToolSource id for the registry (default 'submarine'). */
  id?: string;
}

/** Bind the submarine contract to in-process handlers → an InProcessToolSource. */
export function bindSubmarineTools(handlers: Record<string, SubmarineHandler>, opts: BindSubmarineOptions = {}): InProcessToolSource {
  const bound: InProcessTool[] = [];
  for (const def of SUBMARINE_TOOLS) {
    const handler = handlers[def.name];
    if (!handler) {
      if (opts.allowMissing) continue;
      throw new Error(`bindSubmarineTools: no handler for "${def.name}"`);
    }
    bound.push({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      requiresConfirmation: def.requiresConfirmation,
      handler,
    });
  }
  return new InProcessToolSource(opts.id ?? 'submarine', bound);
}
