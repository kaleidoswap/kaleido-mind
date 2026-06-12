/**
 * KaleidoSwap maker tool source for the CLI — fetch-based handlers that
 * implement the canonical contract from `@kaleidorg/mind`.
 *
 * Pattern: core declares the agent-facing tool shape (simple flat args); this
 * host adapter translates them into the maker's REST request bodies (often
 * nested SwapLegInput objects with a `layer` field). The model never sees the
 * layer / asset_id internals.
 *
 * Routes + body shapes mirror `kaleido_sdk._maker_client.py` / `_generated/api_types.py`.
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
  /** Optional transform from agent-facing args → maker request body. */
  body?: (args: Record<string, unknown>) => unknown;
  /** Optional transform from agent-facing args → query params. */
  query?: (args: Record<string, unknown>) => Record<string, string>;
}

/**
 * Default `layer` for each canonical asset. The maker accepts other layers
 * (Spark / Arkade / Liquid / etc.) but BTC_LN ↔ RGB_LN is the universal pair
 * for the demo. Hosts that want to override (e.g. swap via Spark) can build
 * their own kaleidoswapTools.ts.
 */
function defaultLayer(asset: string): string {
  const a = asset.toUpperCase();
  if (a === 'BTC') return 'BTC_LN';
  return 'RGB_LN'; // USDT, XAUT, and any other RGB asset
}

/** Build the nested SwapLegInput object the maker expects on quote/order requests. */
function leg(asset: unknown, amount?: unknown) {
  const id = String(asset ?? '').toUpperCase();
  const out: Record<string, unknown> = { asset_id: id, layer: defaultLayer(id) };
  if (amount != null && amount !== '') out.amount = Number(amount);
  return out;
}

const ROUTES: Record<string, Route> = {
  kaleidoswap_get_assets: {
    method: 'GET',
    path: '/api/v1/market/assets',
  },
  kaleidoswap_get_pairs: {
    method: 'GET',
    path: '/api/v1/market/pairs',
  },
  kaleidoswap_get_quote: {
    method: 'POST',
    path: '/api/v1/market/quote',
    // Maker expects { from_asset: SwapLegInput, to_asset: SwapLegInput }
    // where SwapLegInput = { asset_id, layer, amount? }. Amount lives on the
    // FROM leg only.
    body: (a) => ({
      from_asset: leg(a.from_asset, a.amount),
      to_asset: leg(a.to_asset),
    }),
  },
  kaleidoswap_get_nodeinfo: {
    method: 'GET',
    path: '/api/v1/swaps/nodeinfo',
  },
  kaleidoswap_place_order: {
    method: 'POST',
    path: '/api/v1/swaps/orders',
    // Maker expects { rfq_id, from_asset: SwapLeg, to_asset: SwapLeg }.
    // We accept either { quote_id } (the agent-friendly shape) or a full
    // explicit body — and re-derive the legs from the prior quote args
    // when the agent only passes quote_id (the recipe path does this).
    body: (a) => ({
      rfq_id: a.quote_id ?? a.rfq_id,
      from_asset: leg(a.from_asset, a.amount),
      to_asset: leg(a.to_asset),
    }),
  },
  kaleidoswap_get_order_status: {
    method: 'POST',
    path: '/api/v1/swaps/orders/status',
    // OrderRequest = { order_id, access_token? }
    body: (a) => ({ order_id: a.order_id, access_token: a.access_token ?? '' }),
  },
  kaleidoswap_get_order_history: {
    method: 'GET',
    path: '/api/v1/swaps/orders/history',
    query: (a) => {
      const q: Record<string, string> = {};
      if (a.limit != null) q.limit = String(a.limit);
      if (a.cursor != null) q.cursor = String(a.cursor);
      return q;
    },
  },
  kaleidoswap_atomic_init: {
    method: 'POST',
    path: '/api/v1/swaps/init',
    // InitSwapRequest is rfq_id-driven. The full body shape varies by swap
    // type; for the demo we forward whatever the agent built and let the
    // maker validate. The atomic recipe will populate this correctly.
    body: (a) => ({ rfq_id: a.quote_id ?? a.rfq_id, ...a }),
  },
  kaleidoswap_atomic_execute: {
    method: 'POST',
    path: '/api/v1/swaps/execute',
    // ConfirmSwapRequest = { swapstring, taker_pubkey }. The atomic recipe
    // gets swapstring from the prior init result; we forward verbatim.
    body: (a) => a,
  },
  kaleidoswap_atomic_status: {
    method: 'POST',
    path: '/api/v1/swaps/atomic/status',
    // SwapStatusRequest = { payment_hash }. The agent-facing field is
    // atomic_id; map it to payment_hash for the maker.
    body: (a) => ({ payment_hash: a.atomic_id ?? a.payment_hash }),
  },
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
      const a = args ?? {};

      if (route.method === 'GET') {
        const params = route.query ? route.query(a) : (
          Object.fromEntries(
            Object.entries(a).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])
          ) as Record<string, string>
        );
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      } else {
        const payload = route.body ? route.body(a) : a;
        init.body = JSON.stringify(payload);
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
