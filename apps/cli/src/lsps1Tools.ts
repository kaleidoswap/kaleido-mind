/**
 * LSPS1 tool source for the CLI — fetch-based handlers that implement the
 * canonical LSP-agnostic contract from `@kaleidorg/mind`.
 *
 * The LSPS1 endpoints happen to live on the maker today (port 8000); the
 * tool names are LSP-agnostic (`lsp_*`) so a different LSP can be swapped
 * in by changing only this file.
 *
 * Routes mirror `kaleido_sdk._maker_client.py`'s LSPS1 surface.
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
}

const ROUTES: Record<string, Route> = {
  lsp_get_info:         { method: 'GET',  path: '/api/v1/lsps1/get_info' },
  lsp_get_network_info: { method: 'GET',  path: '/api/v1/lsps1/network_info' },
  lsp_estimate_fees:    { method: 'POST', path: '/api/v1/lsps1/estimate_fees' },
  lsp_create_order:     { method: 'POST', path: '/api/v1/lsps1/create_order' },
  lsp_get_order:        { method: 'POST', path: '/api/v1/lsps1/get_order' },
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
          `lsps1 ${name} failed: HTTP ${res.status} ${res.statusText}` +
          (typeof text === 'string' && text ? ` — ${text.slice(0, 240)}` : ''),
        );
      }
      return data ?? { ok: true };
    };
  }

  return bindLsps1Tools(handlers);
}
