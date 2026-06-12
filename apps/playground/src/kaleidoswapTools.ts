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

interface Route { method: 'GET' | 'POST'; path: string }

const KALEIDOSWAP_ROUTES: Record<string, Route> = {
  kaleidoswap_get_assets:        { method: 'GET',  path: '/api/v1/market/assets' },
  kaleidoswap_get_pairs:         { method: 'GET',  path: '/api/v1/market/pairs' },
  kaleidoswap_get_quote:         { method: 'POST', path: '/api/v1/market/quote' },
  kaleidoswap_get_nodeinfo:      { method: 'GET',  path: '/api/v1/swaps/nodeinfo' },
  kaleidoswap_place_order:       { method: 'POST', path: '/api/v1/swaps/orders' },
  kaleidoswap_get_order_status:  { method: 'POST', path: '/api/v1/swaps/orders/status' },
  kaleidoswap_get_order_history: { method: 'GET',  path: '/api/v1/swaps/orders/history' },
  kaleidoswap_atomic_init:       { method: 'POST', path: '/api/v1/swaps/init' },
  kaleidoswap_atomic_execute:    { method: 'POST', path: '/api/v1/swaps/execute' },
  kaleidoswap_atomic_status:     { method: 'POST', path: '/api/v1/swaps/atomic/status' },
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
    if (route.method === 'GET') {
      for (const [k, v] of Object.entries(args ?? {})) {
        if (v != null) url.searchParams.set(k, String(v));
      }
    } else {
      init.body = JSON.stringify(args ?? {});
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
