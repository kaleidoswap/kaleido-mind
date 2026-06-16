/**
 * RGB Lightning Node tool source — taker-side ops for the CLI.
 *
 * In a KaleidoSwap atomic swap the maker owns init/execute/status (REST). The
 * taker's RGB node has exactly TWO jobs:
 *   - expose its pubkey  (GET /nodeinfo)         → goes into the maker's execute body
 *   - whitelist the swapstring  (POST /taker)    → ack of "I accept this swap"
 *
 * Plus receive-invoice creation for non-atomic flows:
 *   - rln_create_ln_invoice    (POST /lninvoice)
 *   - rln_create_rgb_invoice   (POST /rgbinvoice)
 *
 * The mind never sees URLs — the fetch lives here. Same shape as kaleidoswapTools.
 *
 * NOT exposed: /makerinit, /makerexecute. Those are for when the LOCAL node
 * acts as the maker — not our case. Atomic init/execute are the MAKER service's
 * REST endpoints (apps/cli/src/kaleidoswapTools.ts), not this node's.
 */

import { InProcessToolSource, type InProcessTool } from '@kaleidorg/mind';

export interface RlnHttpOptions {
  /** RGB Lightning Node base URL, e.g. http://localhost:3001. No trailing slash. */
  baseUrl: string;
  /** Optional Bearer token. Not seen by the model. */
  apiKey?: string;
  /** Override `fetch` for testing. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface Route {
  method: 'GET' | 'POST';
  path: string;
  body?: (args: Record<string, unknown>) => unknown;
  /** Optional spend flag (forwarded to InProcessTool.requiresConfirmation). */
  spend?: boolean;
  /** Optional post-fetch transform — e.g. extract just the pubkey from /nodeinfo. */
  transformResponse?: (data: unknown) => unknown;
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * Project the noisy /nodeinfo dump down to the two fields the swap flow needs.
 * The full response has channel/balance/network counters the agent doesn't
 * need to reason about; surface only what matters and leave the rest raw under
 * `details` for the curious.
 */
function projectNodeInfo(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const d = data as any;
  return {
    pubkey: d.pubkey,
    num_channels: d.num_channels,
    num_usable_channels: d.num_usable_channels,
    local_balance_sat: d.local_balance_sat,
    num_peers: d.num_peers,
    details: d,
  };
}

const ROUTES: Record<string, Route> = {
  rln_get_node_info: {
    method: 'GET',
    path: '/nodeinfo',
    transformResponse: projectNodeInfo,
  },
  rln_list_channels: {
    method: 'GET',
    path: '/listchannels',
    // Project each channel to the capacity-relevant fields so the agent can
    // verify a requested order against what actually opened. inbound/outbound
    // come as msat — convert to sat for easy comparison with order sats.
    transformResponse: (data: unknown) => {
      const list = Array.isArray((data as any)?.channels)
        ? (data as any).channels
        : Array.isArray(data) ? data : [];
      return {
        channels: list.map((c: any) => ({
          channel_id: c.channel_id,
          peer_alias: c.peer_alias,
          status: c.status,
          ready: c.ready,
          is_usable: c.is_usable,
          capacity_sat: c.capacity_sat,
          outbound_sat: c.outbound_balance_msat != null ? Math.round(c.outbound_balance_msat / 1000) : c.local_balance_sat,
          inbound_sat: c.inbound_balance_msat != null ? Math.round(c.inbound_balance_msat / 1000) : undefined,
          asset_id: c.asset_id,
          asset_local_amount: c.asset_local_amount,
          asset_remote_amount: c.asset_remote_amount,
        })),
        count: list.length,
      };
    },
  },
  rln_whitelist_swap: {
    method: 'POST',
    path: '/taker',
    spend: true,           // not a fund move, but a binding ack — confirm-gate it.
    body: (a) => ({ swapstring: String(a.swapstring ?? '') }),
  },
  rln_create_ln_invoice: {
    method: 'POST',
    path: '/lninvoice',
    body: (a) => {
      // Maker schema LNInvoiceRequest:
      //   amt_msat? (sats × 1000), expiry_sec (required), asset_id?, asset_amount?
      const out: Record<string, unknown> = { expiry_sec: Number(a.expiry_sec ?? 3600) };
      if (a.amount_sats != null) out.amt_msat = Math.round(Number(a.amount_sats) * 1000);
      if (a.asset_id != null) out.asset_id = String(a.asset_id);
      if (a.asset_amount != null) out.asset_amount = Number(a.asset_amount);
      return out;
    },
  },
  rln_create_rgb_invoice: {
    method: 'POST',
    path: '/rgbinvoice',
    body: (a) => ({
      min_confirmations: Number(a.min_confirmations ?? 1),
      witness: a.witness != null ? Boolean(a.witness) : false,
      ...(a.asset_id != null ? { asset_id: String(a.asset_id) } : {}),
      ...(a.expiration_timestamp != null
        ? { expiration_timestamp: Number(a.expiration_timestamp) }
        : {}),
    }),
  },
  rln_pay_invoice: {
    method: 'POST',
    path: '/sendpayment',
    spend: true,  // moves real funds — confirmation-gated by the recipe
    body: (a) => ({ invoice: String(a.invoice ?? '') }),
  },
  rln_list_assets: {
    method: 'POST',
    path: '/listassets',
    // The RLN node requires filter_asset_schemas; default to all standard schemas.
    body: (a) => ({
      filter_asset_schemas: Array.isArray(a.filter_asset_schemas)
        ? a.filter_asset_schemas
        : ['Nia', 'Cfa', 'Ifa', 'Uda'],
    }),
  },
  rln_get_asset_balance: {
    method: 'POST',
    path: '/assetbalance',
    body: (a) => ({ asset_id: String(a.asset_id ?? a.asset ?? '') }),
  },
};

/** Build an InProcessToolSource that proxies every taker-side RLN tool over HTTP. */
export function buildRlnToolSource(opts: RlnHttpOptions): InProcessToolSource {
  const fx = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const tools: InProcessTool[] = [];

  for (const [name, route] of Object.entries(ROUTES)) {
    tools.push({
      name,
      description: descriptions[name] ?? name,
      parameters: schemas[name] ?? { type: 'object', properties: {} },
      requiresConfirmation: !!route.spend,
      handler: async (args) => {
        const url = new URL(base + route.path);
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
        const init: RequestInit = { method: route.method, headers };
        if (route.method !== 'GET') {
          init.body = JSON.stringify(route.body ? route.body(args ?? {}) : args ?? {});
        }
        const res = await fx(url.toString(), init);
        const text = await res.text();
        const data = text ? safeJson(text) : null;
        if (!res.ok) {
          throw new Error(
            `rln ${name} failed: HTTP ${res.status} ${res.statusText}` +
            (typeof text === 'string' && text ? ` — ${text.slice(0, 240)}` : ''),
          );
        }
        return route.transformResponse ? route.transformResponse(data) : (data ?? { ok: true });
      },
    });
  }

  return new InProcessToolSource('rln', tools);
}

const descriptions: Record<string, string> = {
  rln_get_node_info:
    "Get the local RGB Lightning Node's info — pubkey, channel counts, balance. " +
    "Use BEFORE kaleidoswap_atomic_execute (the maker needs the pubkey as taker_pubkey) " +
    'or whenever the user asks about the node status.',
  rln_list_channels:
    "List the local node's Lightning channels with per-channel capacity_sat, " +
    'inbound_sat, outbound_sat, status/ready, and RGB asset amounts. Use to ' +
    'VERIFY a channel order opened with the requested capacity, or when the ' +
    'user asks about their channels.',
  rln_whitelist_swap:
    'Whitelist a swapstring on the local node so it accepts the maker-driven swap. ' +
    'Call this AFTER kaleidoswap_atomic_init returned a swapstring and BEFORE ' +
    'kaleidoswap_atomic_execute. The node ACKs the swap; it does NOT move funds ' +
    'yet — funds move when the maker executes.',
  rln_create_ln_invoice:
    'Create a Lightning invoice on the local node to receive a payment. Args: ' +
    '`amount_sats` (optional, omit for amountless invoice), `expiry_sec` (default 3600), ' +
    '`asset_id` + `asset_amount` for RGB-over-LN.',
  rln_create_rgb_invoice:
    'Create an RGB receive invoice on the local node. Args: `min_confirmations` ' +
    '(default 1), `witness` (default false), optional `asset_id`, optional ' +
    '`expiration_timestamp`. Use for receiving RGB assets outside a maker swap.',
  rln_pay_invoice:
    "Pay a Lightning invoice from the local RLN node. SPEND: confirmation-gated. " +
    'Args: `invoice` (BOLT11 string). Returns payment_hash + status on success.',
  rln_list_assets:
    "List RGB assets known to the local node — their asset_id, ticker, name, " +
    'precision, and on-chain + off-chain balances. No args required.',
  rln_get_asset_balance:
    "Get the balance for one RGB asset on the local node, by asset_id. Returns " +
    '`settled`, `future`, `spendable`, `offchain_outbound`, `offchain_inbound`.',
};

const schemas: Record<string, { type: 'object'; properties: Record<string, { type: string; description?: string }>; required?: string[] }> = {
  rln_get_node_info: { type: 'object', properties: {} },
  rln_list_channels: { type: 'object', properties: {} },
  rln_whitelist_swap: {
    type: 'object',
    properties: {
      swapstring: { type: 'string', description: 'The swapstring returned by kaleidoswap_atomic_init.' },
    },
    required: ['swapstring'],
  },
  rln_create_ln_invoice: {
    type: 'object',
    properties: {
      amount_sats: { type: 'number', description: 'Amount in sats. Omit for an amountless invoice.' },
      expiry_sec: { type: 'number', description: 'Invoice expiry in seconds. Default 3600.' },
      asset_id: { type: 'string', description: 'Optional RGB asset id for RGB-over-LN.' },
      asset_amount: { type: 'number', description: 'Required when asset_id is set.' },
    },
  },
  rln_create_rgb_invoice: {
    type: 'object',
    properties: {
      min_confirmations: { type: 'number', description: 'Default 1.' },
      witness: { type: 'string', description: 'Boolean as string ("true" / "false"). Default false.' },
      asset_id: { type: 'string', description: 'Optional RGB asset id (omit for an any-asset invoice).' },
      expiration_timestamp: { type: 'number', description: 'Unix seconds. Optional.' },
    },
  },
  rln_pay_invoice: {
    type: 'object',
    properties: {
      invoice: { type: 'string', description: 'BOLT11 Lightning invoice to pay.' },
    },
    required: ['invoice'],
  },
  rln_list_assets: { type: 'object', properties: {} },
  rln_get_asset_balance: {
    type: 'object',
    properties: { asset_id: { type: 'string', description: 'RGB asset id (e.g. rgb:...)' } },
    required: ['asset_id'],
  },
};
