/**
 * LSPS1 tool source for the CLI — fetch-based handlers that implement the
 * canonical LSP-agnostic contract from `@kaleidorg/mind`.
 *
 * The LSPS1 endpoints happen to live on the maker today (port 8000); the tool
 * names are LSP-agnostic (`lsp_*`) so a different LSP can be swapped in by
 * changing only this file.
 *
 * The agent-facing contract is flat (`lsp_balance_sat`, `channel_expiry_blocks`,
 * etc.). This adapter fills in the maker's required-but-typically-defaulted
 * fields (`required_channel_confirmations`, `funding_confirms_within_blocks`,
 * `announce_channel`, `client_balance_sat`) so the model doesn't have to.
 *
 * Routes + body shapes mirror `kaleido_sdk._maker_client.py` and the maker's
 * `app/api/v1/lsps1.py` + `app/models/lsps1.py`.
 */

import {
  bindLsps1Tools,
  type InProcessToolSource,
  type Lsps1Handler,
} from '@kaleidorg/mind';

export interface Lsps1HttpOptions {
  /** LSP base URL, e.g. http://localhost:8000. No trailing slash. */
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
  query?: (args: Record<string, unknown>) => Record<string, string>;
}

/** Sensible defaults for fields the agent often won't think to set. */
const DEFAULTS = {
  client_balance_sat: 0,
  required_channel_confirmations: 1,
  funding_confirms_within_blocks: 6,
  channel_expiry_blocks: 4320, // ~30 days at 10 min blocks
  announce_channel: true,
};

function num(x: unknown, dflt: number): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : dflt;
}

function bool(x: unknown, dflt: boolean): boolean {
  if (x === undefined || x === null) return dflt;
  if (typeof x === 'boolean') return x;
  if (x === 'true') return true;
  if (x === 'false') return false;
  return dflt;
}

const ROUTES: Record<string, Route> = {
  lsp_get_info: {
    method: 'GET',
    path: '/api/v1/lsps1/get_info',
  },
  lsp_get_network_info: {
    method: 'GET',
    path: '/api/v1/lsps1/network_info',
  },
  lsp_estimate_fees: {
    method: 'POST',
    path: '/api/v1/lsps1/estimate_fees',
    // EstimateFeesRequest = { lsp_balance_sat, client_balance_sat, channel_expiry_blocks,
    //   token?, asset_id?, lsp_asset_amount?, client_asset_amount?, rfq_id? }
    body: (a) => ({
      lsp_balance_sat: num(a.lsp_balance_sat, 0),
      client_balance_sat: num(a.client_balance_sat, DEFAULTS.client_balance_sat),
      channel_expiry_blocks: num(a.channel_expiry_blocks, DEFAULTS.channel_expiry_blocks),
      ...(a.token != null ? { token: a.token } : {}),
      ...(a.asset_id != null ? { asset_id: a.asset_id } : {}),
      ...(a.lsp_asset_amount != null ? { lsp_asset_amount: a.lsp_asset_amount } : {}),
      ...(a.client_asset_amount != null ? { client_asset_amount: a.client_asset_amount } : {}),
      ...(a.rfq_id != null ? { rfq_id: a.rfq_id } : {}),
    }),
  },
  lsp_create_order: {
    method: 'POST',
    path: '/api/v1/lsps1/create_order',
    // CreateOrderRequest = { client_pubkey, lsp_balance_sat, client_balance_sat,
    //   required_channel_confirmations, funding_confirms_within_blocks,
    //   channel_expiry_blocks, announce_channel, token?, refund_onchain_address?,
    //   asset_id?, lsp_asset_amount?, client_asset_amount?, rfq_id?, email? }
    body: (a) => ({
      client_pubkey: String(a.client_pubkey ?? ''),
      lsp_balance_sat: num(a.lsp_balance_sat, 0),
      client_balance_sat: num(a.client_balance_sat, DEFAULTS.client_balance_sat),
      required_channel_confirmations: num(a.required_channel_confirmations, DEFAULTS.required_channel_confirmations),
      funding_confirms_within_blocks: num(a.funding_confirms_within_blocks, DEFAULTS.funding_confirms_within_blocks),
      channel_expiry_blocks: num(a.channel_expiry_blocks, DEFAULTS.channel_expiry_blocks),
      announce_channel: bool(a.announce_channel, DEFAULTS.announce_channel),
      ...(a.token != null ? { token: a.token } : {}),
      ...(a.refund_onchain_address != null ? { refund_onchain_address: a.refund_onchain_address } : {}),
      ...(a.asset_id != null ? { asset_id: a.asset_id } : {}),
      ...(a.lsp_asset_amount != null ? { lsp_asset_amount: a.lsp_asset_amount } : {}),
      ...(a.client_asset_amount != null ? { client_asset_amount: a.client_asset_amount } : {}),
      ...(a.rfq_id != null ? { rfq_id: a.rfq_id } : {}),
      ...(a.email != null ? { email: a.email } : {}),
    }),
  },
  lsp_get_order: {
    method: 'POST',
    path: '/api/v1/lsps1/get_order',
    // OrderRequest = { order_id, access_token }
    body: (a) => ({
      order_id: String(a.order_id ?? ''),
      access_token: a.access_token != null ? String(a.access_token) : '',
    }),
  },
};

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/** Build an InProcessToolSource that proxies every LSPS1 tool over HTTP. */
export function buildLsps1ToolSource(opts: Lsps1HttpOptions): InProcessToolSource {
  const fx = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const handlers: Record<string, Lsps1Handler> = {};

  for (const [name, route] of Object.entries(ROUTES)) {
    handlers[name] = async (args) => {
      const url = new URL(base + route.path);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

      const init: RequestInit = { method: route.method, headers };
      const a = args ?? {};
      if (route.method === 'GET') {
        const params = route.query ? route.query(a) : {};
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
      } else {
        init.body = JSON.stringify(route.body ? route.body(a) : a);
      }

      const res = await fx(url.toString(), init);
      const text = await res.text();
      const data = text ? safeJson(text) : null;
      if (!res.ok) {
        throw new Error(
          `lsps1 ${name} failed: HTTP ${res.status} ${res.statusText}` +
          (typeof text === 'string' && text ? ` — ${text.slice(0, 240)}` : ''),
        );
      }
      return data ?? { ok: true };
    };
  }

  return bindLsps1Tools(handlers);
}
