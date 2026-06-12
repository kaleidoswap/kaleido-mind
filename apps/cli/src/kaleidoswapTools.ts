/**
 * KaleidoSwap maker tool source for the CLI — fetch-based handlers that
 * implement the canonical contract from `@kaleidorg/mind`.
 *
 * Pattern: core declares the tool shape; the host (this file) supplies the
 * transport. The mind never sees URLs.
 *
 * Routes mirror what `kaleido_sdk._maker_client.py` calls — keep them in sync
 * if the maker's REST surface changes.
 */

import {
  bindKaleidoswapTools,
  type InProcessToolSource,
  type KaleidoswapHandler,
} from '@kaleidorg/mind';

export interface KaleidoswapHttpOptions {
  /** Maker base URL, e.g. http://localhost:8000. No trailing slash. */
  baseUrl: string;
  /** Optional Bearer token. Maker auth — not seen by the model. */
  apiKey?: string;
  /** Override `fetch` for testing. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface Route {
  method: 'GET' | 'POST';
  path: string;
}

const ROUTES: Record<string, Route> = {
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

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/** Build an InProcessToolSource that proxies every maker tool over HTTP. */
export function buildKaleidoswapToolSource(opts: KaleidoswapHttpOptions): InProcessToolSource {
  const fx = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const handlers: Record<string, KaleidoswapHandler> = {};

  for (const [name, route] of Object.entries(ROUTES)) {
    handlers[name] = async (args) => {
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
          `kaleidoswap maker ${name} failed: HTTP ${res.status} ${res.statusText}` +
          (typeof text === 'string' && text ? ` — ${text.slice(0, 240)}` : ''),
        );
      }
      return data ?? { ok: true };
    };
  }

  return bindKaleidoswapTools(handlers);
}
