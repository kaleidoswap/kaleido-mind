/**
 * KaleidoSwap maker tool source for the playground — fetch-based handlers
 * over the canonical contract from `@kaleidorg/mind`. Same shape as the
 * CLI's kaleidoswapTools.ts; duplicated here on purpose to keep the apps
 * self-contained (no shared host-side package yet).
 *
 * The mind never sees URLs — the HTTP call lives here.
 */

import {
  bindKaleidoswapTools,
  bindLsps1Tools,
  type InProcessToolSource,
  type KaleidoswapHandler,
  type Lsps1Handler,
} from '@kaleidorg/mind';

export interface MakerHttpOptions {
  /** Maker base URL, e.g. http://localhost:8000. No trailing slash. */
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

// Default settlement layer per asset. The maker accepts more (Spark, Arkade,
// Liquid, …) but BTC_LN ↔ RGB_LN is the universal pair for the demo.
function defaultLayer(asset: string): string {
  return asset.toUpperCase() === 'BTC' ? 'BTC_LN' : 'RGB_LN';
}

// Maker REST precision (verified against /api/v1/market/assets on localhost:8000)
// and the unit users actually speak. Host scales user_amount × 10^(MP−UP) before
// hitting the maker — otherwise "100,000 sats" gets quoted as 100 sats and "10 USDT"
// as 0.00001 USDT (the maker takes amounts in its smallest unit).
const MAKER_PRECISION: Record<string, number> = { BTC: 11, USDT: 6, XAUT: 9 };
const USER_NATURAL_PRECISION: Record<string, number> = { BTC: 8, USDT: 0, XAUT: 0 };

function scaleAmount(asset: string, amount: number): number {
  if (!Number.isFinite(amount)) return amount;
  const mp = MAKER_PRECISION[asset];
  const up = USER_NATURAL_PRECISION[asset];
  if (mp == null || up == null) return Math.round(amount);
  if (amount >= 10 ** mp) return Math.round(amount); // already smallest-unit
  return Math.round(amount * 10 ** (mp - up));
}

function leg(asset: unknown, amount?: unknown) {
  const id = String(asset ?? '').toUpperCase();
  const out: Record<string, unknown> = { asset_id: id, layer: defaultLayer(id) };
  if (amount != null && amount !== '') out.amount = scaleAmount(id, Number(amount));
  return out;
}

const KALEIDOSWAP_ROUTES: Record<string, Route> = {
  kaleidoswap_get_assets:   { method: 'GET',  path: '/api/v1/market/assets' },
  kaleidoswap_get_pairs:    { method: 'GET',  path: '/api/v1/market/pairs' },
  kaleidoswap_get_quote: {
    method: 'POST', path: '/api/v1/market/quote',
    // amount_side picks which leg carries the amount: 'to' for buy, else 'from'.
    body: (a) => a.amount_side === 'to'
      ? { from_asset: leg(a.from_asset), to_asset: leg(a.to_asset, a.amount) }
      : { from_asset: leg(a.from_asset, a.amount), to_asset: leg(a.to_asset) },
  },
  kaleidoswap_get_nodeinfo: { method: 'GET',  path: '/api/v1/swaps/nodeinfo' },
  kaleidoswap_place_order: {
    method: 'POST', path: '/api/v1/swaps/orders',
    body: (a) => {
      const rfq_id = a.quote_id ?? a.rfq_id;
      if (a.from_asset != null && a.to_asset != null) return { rfq_id, from_asset: leg(a.from_asset, a.amount), to_asset: leg(a.to_asset) };
      return { rfq_id };
    },
  },
  kaleidoswap_get_order_status: {
    method: 'POST', path: '/api/v1/swaps/orders/status',
    body: (a) => ({ order_id: a.order_id, access_token: a.access_token ?? '' }),
  },
  kaleidoswap_get_order_history: { method: 'GET', path: '/api/v1/swaps/orders/history' },
  kaleidoswap_atomic_init: {
    method: 'POST', path: '/api/v1/swaps/init',
    body: (a) => ({ rfq_id: a.quote_id ?? a.rfq_id, ...a }),
  },
  kaleidoswap_atomic_execute: { method: 'POST', path: '/api/v1/swaps/execute', body: (a) => a },
  kaleidoswap_atomic_status: {
    method: 'POST', path: '/api/v1/swaps/atomic/status',
    body: (a) => ({ payment_hash: a.atomic_id ?? a.payment_hash }),
  },
};

const LSPS1_ROUTES: Record<string, Route> = {
  lsp_get_info:         { method: 'GET',  path: '/api/v1/lsps1/get_info' },
  lsp_get_network_info: { method: 'GET',  path: '/api/v1/lsps1/network_info' },
  lsp_estimate_fees:    { method: 'POST', path: '/api/v1/lsps1/estimate_fees' },
  lsp_create_order:     { method: 'POST', path: '/api/v1/lsps1/create_order' },
  lsp_get_order:        { method: 'POST', path: '/api/v1/lsps1/get_order' },
};

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

function httpHandler(opts: MakerHttpOptions, name: string, route: Route) {
  const fx = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  return async (args: Record<string, unknown>): Promise<unknown> => {
    const url = new URL(base + route.path);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    const init: RequestInit = { method: route.method, headers };
    const a = args ?? {};
    if (route.method === 'GET') {
      const params = route.query
        ? route.query(a)
        : Object.fromEntries(Object.entries(a).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    } else {
      init.body = JSON.stringify(route.body ? route.body(a) : a);
    }
    const res = await fx(url.toString(), init);
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) {
      throw new Error(
        `${name} failed: HTTP ${res.status} ${res.statusText}` +
        (typeof text === 'string' && text ? ` — ${text.slice(0, 240)}` : ''),
      );
    }
    return data ?? { ok: true };
  };
}

export function buildKaleidoswapToolSource(opts: MakerHttpOptions): InProcessToolSource {
  const handlers: Record<string, KaleidoswapHandler> = {};
  for (const [name, route] of Object.entries(KALEIDOSWAP_ROUTES)) {
    handlers[name] = httpHandler(opts, `kaleidoswap maker ${name}`, route);
  }
  return bindKaleidoswapTools(handlers);
}

export function buildLsps1ToolSource(opts: MakerHttpOptions): InProcessToolSource {
  const handlers: Record<string, Lsps1Handler> = {};
  for (const [name, route] of Object.entries(LSPS1_ROUTES)) {
    handlers[name] = httpHandler(opts, `lsps1 ${name}`, route);
  }
  return bindLsps1Tools(handlers);
}
