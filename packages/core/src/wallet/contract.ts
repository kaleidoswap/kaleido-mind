/**
 * Canonical multi-L2 wallet tool contract — the single source of truth for
 * KaleidoMind's wallet tools (names + JSON schemas + spend flags).
 *
 * Every surface implements THESE EXACT tools, only the transport differs:
 *   - mobile  → in-process handlers over the WDK adapters (`bindWalletTools`)
 *   - desktop → kaleido-mcp (tools namespaced per layer) + a `kaleido` CLI
 *   - eval    → stub handlers
 *
 * Because the schemas are identical everywhere, skills are portable and the
 * model comparison is honest. Tools are namespaced per layer (`spark_*`,
 * `rln_*`, `arkade_*`, `liquid_*`); cross-cutting router/helpers are unprefixed.
 *
 * Spend tools (move funds) carry `spend: true` → `requiresConfirmation: true`,
 * so the Engine always pauses for the host's confirm gate before executing.
 *
 * Pure data — no deps, RN-safe.
 */

import type { ToolDef } from '../types.js';
import { InProcessToolSource } from '../tools/in-process.js';
import type { InProcessTool } from '../tools/in-process.js';

export type WalletLayer = 'spark' | 'rln' | 'arkade' | 'liquid' | 'core';

export interface WalletToolDef extends ToolDef {
  /** Which L2 (or 'core' for cross-cutting router/helpers). */
  layer: WalletLayer;
  /** Moves funds → confirmation-gated. */
  spend?: boolean;
}

type Props = Record<string, { type: string; description?: string; enum?: string[] }>;

function t(
  layer: WalletLayer,
  name: string,
  description: string,
  properties: Props = {},
  required: string[] = [],
  spend = false,
): WalletToolDef {
  return {
    layer,
    name,
    description,
    spend,
    requiresConfirmation: spend,
    parameters: { type: 'object', properties, required },
  };
}

const sats = { type: 'number', description: 'Amount in satoshis' } as const;
const asset = { type: 'string', description: "Asset ticker, e.g. 'USDT', 'XAUT', 'BTC'" } as const;

/** The full contract. Keep descriptions terse — small models read every word. */
export const WALLET_TOOLS: WalletToolDef[] = [
  // ── Spark ──────────────────────────────────────────────────────────────
  t('spark', 'spark_get_balance', 'Get the Spark wallet BTC balance. Use for ANY "balance / how much / what do I have on Spark" question — call it fresh every time, balances change.'),
  t('spark', 'spark_get_address', 'Get or create a Spark address to receive BTC. This is the ONE tool for "my address", "create/generate/give me an address", "where do I receive" — Spark addresses are reusable, so getting and creating are the same operation. ALWAYS call this; never claim you cannot create an address.'),
  t('spark', 'spark_create_invoice', 'Create a Spark Lightning invoice to receive BTC.', { amount_sats: sats }),
  // Explicit Lightning-invoice payer. BOLT11 invoices encode the amount, so
  // `amount_sats` is optional and only used for amount-less ("any-amount")
  // invoices. Prefer this over `spark_send` when the destination is a BOLT11
  // invoice — it removes ambiguity for small models and gives the cross-skill
  // bitrefill flow a single, unambiguous target.
  t('spark', 'spark_pay_invoice',
    'Pay a Lightning (BOLT11) invoice from the Spark wallet. The invoice already encodes the amount; pass amount_sats ONLY for amount-less invoices. Use this for any BOLT11 destination (Bitrefill, contact, raw invoice).',
    { invoice: { type: 'string', description: 'BOLT11 Lightning invoice (lnbc…/lntb…/lnbcrt…).' }, amount_sats: { type: 'number', description: 'Required ONLY when the invoice has no amount; omit otherwise.' } },
    ['invoice'],
    /* spend */ true),
  t('spark', 'spark_send',
    'Send BTC from Spark to an on-chain address (bc1…/tb1…). For BOLT11 invoices, prefer spark_pay_invoice.',
    { amount_sats: sats, to: { type: 'string', description: 'On-chain Bitcoin address.' } },
    ['amount_sats', 'to'],
    /* spend */ true),

  // ── RLN / RGB ──────────────────────────────────────────────────────────
  t('rln', 'rln_get_balances', 'Get RLN node balances (BTC + RGB assets).'),
  t('rln', 'rln_get_node_info', 'Get RLN node status and sync state.'),
  t('rln', 'rln_list_channels', 'List the RLN node Lightning channels.'),
  t('rln', 'rln_create_ln_invoice', 'Create a Lightning (BTC) invoice on the RLN node.', { amount_sats: sats }),
  t('rln', 'rln_create_rgb_invoice', 'Create an RGB asset invoice to receive an asset (e.g. USDT).', { asset, amount: { type: 'number', description: 'Asset amount' } }, ['asset', 'amount']),
  t('rln', 'rln_pay_invoice', 'Pay a Lightning invoice from the RLN node.', { invoice: { type: 'string' } }, ['invoice'], true),
  t('rln', 'rln_send_asset', 'Send an RGB asset (e.g. USDT) to a recipient.', { asset, amount: { type: 'number' }, to: { type: 'string' } }, ['asset', 'amount', 'to'], true),

  // ── Arkade ─────────────────────────────────────────────────────────────
  t('arkade', 'arkade_get_balance', 'Get the Arkade wallet balance.'),
  t('arkade', 'arkade_get_address', 'Get an Arkade address to receive funds.'),
  t('arkade', 'arkade_send', 'Send BTC from Arkade to a recipient.', { amount_sats: sats, to: { type: 'string' } }, ['amount_sats', 'to'], true),

  // ── Liquid (later) ─────────────────────────────────────────────────────
  t('liquid', 'liquid_get_balance', 'Get the Liquid wallet balance (L-BTC + assets).'),
  t('liquid', 'liquid_create_invoice', 'Create a Liquid invoice/address to receive (L-BTC or L-USDt).', { asset, amount: { type: 'number' } }),
  t('liquid', 'liquid_send', 'Send a Liquid asset (L-BTC or L-USDt) to a recipient.', { asset, amount: { type: 'number' }, to: { type: 'string' } }, ['asset', 'amount', 'to'], true),

  // ── Core: router + helpers ─────────────────────────────────────────────
  t('core', 'get_balances', 'Get balances across all layers (or one layer).', { layer: { type: 'string', enum: ['spark', 'rln', 'arkade', 'liquid'], description: 'Optional: a single layer' } }),
  t('core', 'resolve_contact', 'Resolve a contact name to a Lightning address / Nostr / preferred rail.', { name: { type: 'string', description: 'Contact name, e.g. "bob"' } }, ['name']),
  t('core', 'get_price', 'Get the current price of an asset, optionally in a fiat currency.', { asset, fiat: { type: 'string', description: "Fiat code, e.g. 'EUR', 'USD'" } }),
  t('core', 'fiat_to_sats', 'Convert a fiat amount to satoshis at the current rate.', { amount: { type: 'number' }, currency: { type: 'string', description: "Fiat code, e.g. 'EUR'" } }, ['amount', 'currency']),
  t('core', 'get_swap_quote', 'Quote a swap between two assets.', { from_asset: asset, to_asset: asset, amount: { type: 'number' } }, ['from_asset', 'to_asset', 'amount']),
  t('core', 'execute_swap', 'Execute a previously quoted swap.', { quote_id: { type: 'string' }, from_asset: asset, to_asset: asset, amount: { type: 'number' } }, [], true),
  // The high-level entry a skill prefers — picks the rail for the asset, or uses `layer`.
  t('core', 'send_payment', 'Send a payment, automatically choosing the best layer for the asset (or use `layer`).', { asset, amount_sats: sats, to: { type: 'string', description: 'Contact, address, or invoice' }, layer: { type: 'string', enum: ['spark', 'rln', 'arkade', 'liquid'] } }, ['to'], true),
  // High-level receive — picks the right invoice/address tool for the asset/layer.
  t('core', 'create_invoice', 'Create an invoice or address to receive funds, choosing the rail for the asset (or use `layer`). Omit amount for an any-amount invoice.', { asset, amount: { type: 'number', description: 'Amount (sats for BTC, asset units otherwise) — optional' }, layer: { type: 'string', enum: ['spark', 'rln', 'arkade', 'liquid'] } }),
];

// ── Selectors ───────────────────────────────────────────────────────────────

export const WALLET_LAYERS: WalletLayer[] = ['spark', 'rln', 'arkade', 'liquid', 'core'];

/** Names of all spend (fund-moving) tools — these are confirmation-gated. */
export const SPEND_TOOLS: ReadonlySet<string> = new Set(WALLET_TOOLS.filter((x) => x.spend).map((x) => x.name));

export function isSpendTool(name: string): boolean {
  return SPEND_TOOLS.has(name);
}

export function getWalletTool(name: string): WalletToolDef | undefined {
  return WALLET_TOOLS.find((x) => x.name === name);
}

/** Pick the contract tools for the given layers (core helpers included by default). */
export function walletTools(opts: { layers?: WalletLayer[]; includeCore?: boolean } = {}): WalletToolDef[] {
  const layers = new Set(opts.layers ?? (['spark', 'rln', 'arkade', 'liquid'] as WalletLayer[]));
  if (opts.includeCore !== false) layers.add('core');
  return WALLET_TOOLS.filter((x) => layers.has(x.layer));
}

/** Strip to plain ToolDefs (drop the layer/spend metadata). */
export function toToolDefs(tools: WalletToolDef[]): ToolDef[] {
  return tools.map(({ name, description, parameters, requiresConfirmation }) => ({ name, description, parameters, requiresConfirmation }));
}

/** A handler bound to one contract tool. */
export type WalletHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface BindWalletOptions {
  layers?: WalletLayer[];
  includeCore?: boolean;
  /** Skip tools that have no handler instead of throwing (default false). */
  allowMissing?: boolean;
  id?: string;
}

/**
 * Bind contract tools to in-process handlers → an InProcessToolSource. The
 * mobile (and eval) binding: pass a map of `{ toolName: handler }` and you get a
 * ToolSource implementing the canonical schemas with spend flags preserved.
 */
export function bindWalletTools(handlers: Record<string, WalletHandler>, opts: BindWalletOptions = {}): InProcessToolSource {
  const tools = walletTools(opts);
  const bound: InProcessTool[] = [];
  for (const def of tools) {
    const handler = handlers[def.name];
    if (!handler) {
      if (opts.allowMissing) continue;
      throw new Error(`bindWalletTools: no handler for "${def.name}"`);
    }
    bound.push({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      requiresConfirmation: def.requiresConfirmation,
      handler,
    });
  }
  return new InProcessToolSource(opts.id ?? 'wallet', bound);
}
