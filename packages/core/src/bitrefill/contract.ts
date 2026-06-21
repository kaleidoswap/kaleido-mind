/**
 * Canonical Bitrefill tool contract — gift cards, mobile top-ups, eSIMs.
 *
 * Same pattern as the LSPS1 contract: the tool *names + schemas* live here so
 * every host (CLI REST adapter, desktop MCP, mobile WDK adapter) exposes the
 * exact same surface to the agent. Only the transport differs.
 *
 *   - CLI / desktop server → REST against `https://api.bitrefill.com/v2`
 *     (see `apps/cli/src/bitrefillTools.ts`).
 *   - Desktop sidecar      → the remote MCP at `api.bitrefill.com/mcp` already
 *     exposes equivalent tools under different names; a binder there can
 *     rename them to this contract for parity.
 *
 * `bitrefill_create_invoice` is the spend — confirmation-gated by the contract.
 * Everything else is read-only (search, product details, balance, invoice/order
 * status). Invoice creation supports `payment_method:"balance"` (instant, pulls
 * from pre-funded account) or `lightning|bitcoin|usdc_base|...` (the response
 * carries a payment URI/invoice; the user pays out-of-band, then the order is
 * fulfilled).
 *
 * Pure data — no deps, no fetch, RN-safe.
 */

import type { ToolDef } from '../types.js';
import { InProcessToolSource } from '../tools/in-process.js';
import type { InProcessTool } from '../tools/in-process.js';

export interface BitrefillToolDef extends ToolDef {
  /** Moves real money → confirmation-gated. */
  spend?: boolean;
}

type Props = Record<
  string,
  { type: string; description?: string; enum?: string[]; items?: unknown }
>;

function t(
  name: string,
  description: string,
  properties: Props = {},
  required: string[] = [],
  spend = false,
): BitrefillToolDef {
  return {
    name,
    description,
    spend,
    requiresConfirmation: spend,
    parameters: { type: 'object', properties, required },
  };
}

/**
 * The canonical Bitrefill tool list. Each host's binder translates these
 * args into the Bitrefill REST body (CLI) or MCP/CLI call (other hosts).
 */
export const BITREFILL_TOOLS: BitrefillToolDef[] = [
  t(
    'bitrefill_search',
    "Search Bitrefill's product catalog by keyword (brand, country, type). Returns up to ~20 matches with `id`, `name`, `country`, `category` and `denominations`. The model picks the right product id and then calls `bitrefill_get_product` for the package list.",
    {
      query: { type: 'string', description: 'Search keyword. e.g. "amazon", "steam", "vodafone uk", "esim europe".' },
      country: { type: 'string', description: 'OPTIONAL — ISO country code to scope results (e.g. "US", "GB", "DE"). Many brands are country-specific.' },
      limit: { type: 'number', description: 'OPTIONAL — max results (1–25, default 10).' },
    },
    ['query'],
  ),

  t(
    'bitrefill_get_product',
    "Get full details for one product, including its `packages` array (each package = a denomination with `id`, `value`, `price`, `currency`). Use the package `id` (NOT the bare value) when creating an invoice.",
    {
      product_id: { type: 'string', description: 'Product slug from bitrefill_search, e.g. "amazon-us", "steam-us".' },
    },
    ['product_id'],
  ),

  t(
    'bitrefill_get_balance',
    "Get the user's Bitrefill account balance (the pre-funded pool used by `payment_method:\"balance\"`). Returns `{ balance, currency }`. No args.",
  ),

  t(
    'bitrefill_create_invoice',
    "SPEND: confirmation-gated. Create an invoice for one or more products. Pass `payment_method:\"balance\"` + `auto_pay:true` for instant fulfillment from the account balance (lowest blast radius). For Lightning/on-chain, omit `auto_pay`, set `payment_method:\"lightning\"` (etc.) and `refund_address` — the response carries the payment URI; poll `bitrefill_get_invoice` until status=\"complete\" and then read the order. Up to 20 line items per invoice.",
    {
      products: {
        type: 'array',
        description: 'Line items. Each: { product_id, package_id, quantity }. Get `package_id` from bitrefill_get_product (NOT the bare denomination value).',
        items: {
          type: 'object',
          properties: {
            product_id: { type: 'string' },
            package_id: { type: 'string' },
            quantity: { type: 'number' },
          },
          required: ['product_id', 'package_id', 'quantity'],
        },
      },
      payment_method: {
        type: 'string',
        description: 'How to pay: "balance" (account balance, instant), "lightning", "bitcoin", "usdc_base" (x402), "usdc_polygon", "usdt_tron", etc.',
        enum: ['balance', 'lightning', 'bitcoin', 'usdc_base', 'usdc_polygon', 'usdc_ethereum', 'usdt_tron', 'usdt_ethereum'],
      },
      auto_pay: { type: 'boolean', description: 'Required true with `payment_method:"balance"` for instant settlement. Omit for crypto methods.' },
      refund_address: { type: 'string', description: 'REQUIRED for non-balance crypto methods — refund destination if the invoice expires or partially pays.' },
      email: { type: 'string', description: 'OPTIONAL — delivery / receipt email. Defaults to the account email when authenticated.' },
      webhook_url: { type: 'string', description: 'OPTIONAL — URL Bitrefill calls when the order is delivered.' },
    },
    ['products', 'payment_method'],
    /* spend */ true,
  ),

  t(
    'bitrefill_get_invoice',
    "Get the invoice's current status: `unpaid`, `pending`, `paid`, `complete`, `expired`, `failed`. For crypto payment methods, poll this until `complete`; then call `bitrefill_get_order` for redemption details.",
    {
      invoice_id: { type: 'string', description: 'Invoice id returned by bitrefill_create_invoice.' },
    },
    ['invoice_id'],
  ),

  t(
    'bitrefill_get_order',
    "Get an order's redemption details once delivered. Returns `redemption_info` containing the code, PIN (for prepaid cards), redemption link, instructions. ONLY call after the corresponding invoice status is `complete`. Treat the returned code as cash — never paste it in shared chats.",
    {
      order_id: { type: 'string', description: 'Order id from a completed invoice (`order_id` on the invoice or in its `orders[]`).' },
    },
    ['order_id'],
  ),
];

/** All Bitrefill tool names that move money (confirmation-gated). */
export const BITREFILL_SPEND_TOOLS: Set<string> = new Set(
  BITREFILL_TOOLS.filter((t) => t.spend).map((t) => t.name),
);

export function isBitrefillSpendTool(name: string): boolean {
  return BITREFILL_SPEND_TOOLS.has(name);
}

export function getBitrefillTool(name: string): BitrefillToolDef | undefined {
  return BITREFILL_TOOLS.find((t) => t.name === name);
}

/** A handler bound to one Bitrefill tool. */
export type BitrefillHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface BindBitrefillOptions {
  /** Skip tools without a handler instead of throwing (default false). */
  allowMissing?: boolean;
  /** ToolSource id for the registry (default 'bitrefill'). */
  id?: string;
}

/**
 * Bind Bitrefill contract tools to in-process handlers → an InProcessToolSource.
 *
 *   const source = bindBitrefillTools({
 *     bitrefill_search:         async (args) => api.search(args),
 *     bitrefill_get_product:    async ({ product_id }) => api.product(product_id),
 *     bitrefill_get_balance:    async () => api.balance(),
 *     bitrefill_create_invoice: async (args) => api.createInvoice(args),
 *     bitrefill_get_invoice:    async ({ invoice_id }) => api.invoice(invoice_id),
 *     bitrefill_get_order:      async ({ order_id }) => api.order(order_id),
 *   });
 *   tools.register(source);
 */
export function bindBitrefillTools(
  handlers: Record<string, BitrefillHandler>,
  opts: BindBitrefillOptions = {},
): InProcessToolSource {
  const bound: InProcessTool[] = [];
  for (const def of BITREFILL_TOOLS) {
    const handler = handlers[def.name];
    if (!handler) {
      if (opts.allowMissing) continue;
      throw new Error(`bindBitrefillTools: no handler for "${def.name}"`);
    }
    bound.push({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      requiresConfirmation: def.requiresConfirmation,
      handler,
    });
  }
  return new InProcessToolSource(opts.id ?? 'bitrefill', bound);
}
