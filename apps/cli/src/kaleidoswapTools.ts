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
  /**
   * Optional transform of the maker's response BEFORE it reaches the model.
   * Used to add precomputed human-readable fields so a small model never has
   * to do unit math (which it gets wrong — it parrots example numbers instead).
   */
  transformResponse?: (data: unknown) => unknown;
}

/** Scale a smallest-unit integer by its precision into a human decimal string. */
function scaled(amount: unknown, precision: unknown): string | undefined {
  const a = Number(amount);
  const p = Number(precision);
  if (!Number.isFinite(a) || !Number.isFinite(p)) return undefined;
  const v = a / 10 ** p;
  // Trim trailing zeros but keep it readable.
  return v.toLocaleString('en-US', { maximumFractionDigits: Math.min(p, 8) });
}

/**
 * Enrich a quote response with `*_display` strings the model can read verbatim,
 * so it never computes amount ÷ 10^precision itself. Leaves the raw fields
 * intact for any host that wants them.
 */
function enrichQuote(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const d = data as any;
  const from = d.from_asset ?? {};
  const to = d.to_asset ?? {};
  const fee = d.fee ?? {};
  const fromDisp = scaled(from.amount, from.precision);
  const toDisp = scaled(to.amount, to.precision);
  const feeDisp = scaled(fee.final_fee, fee.fee_asset_precision);
  return {
    ...d,
    from_amount_display: fromDisp != null ? `${fromDisp} ${from.ticker ?? from.asset_id ?? ''}`.trim() : undefined,
    to_amount_display: toDisp != null ? `${toDisp} ${to.ticker ?? to.asset_id ?? ''}`.trim() : undefined,
    fee_display: feeDisp != null ? `${feeDisp} ${fee.fee_asset ?? ''}`.trim() : undefined,
  };
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

/**
 * Normalize whatever the model passed as an asset code into the maker's
 * canonical id. The 0.6B sometimes types "sats" or "tether" as the asset_id
 * even when prompted not to — fix at the host instead of whack-a-mole on the
 * prompt (project's "don't ask the small model to do the slow/weak parts"
 * philosophy). Unknown inputs are passed through uppercased so an explicit
 * `rgb:xxx` contract id still works.
 */
function normalizeAsset(asset: unknown): string {
  const raw = String(asset ?? '').trim();
  const a = raw.toUpperCase();
  // BTC family — anything denominated in satoshis IS Bitcoin.
  if (a === 'BTC' || a === 'BITCOIN' || a === 'SATS' || a === 'SAT' || a === 'SATOSHI' || a === 'SATOSHIS') return 'BTC';
  // USDT family — common misnamings (USD, TETHER, USDT).
  if (a === 'USDT' || a === 'USD' || a === 'TETHER') return 'USDT';
  // XAUT family — Tether Gold.
  if (a === 'XAUT' || a === 'XAU' || a === 'GOLD') return 'XAUT';
  // Anything else (e.g. an explicit rgb: contract id) — pass through unchanged
  // case-wise — `rgb:` ids are case-sensitive so don't upper-case those.
  if (raw.startsWith('rgb:')) return raw;
  return a;
}

/** Build the nested SwapLegInput object the maker expects on quote/order requests. */
function leg(asset: unknown, amount?: unknown) {
  const id = normalizeAsset(asset);
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
    // Precompute human amounts so the model reads a string, never does the
    // amount ÷ 10^precision math (a 0.6B parrots example numbers instead).
    transformResponse: enrichQuote,
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
    body: (a) => {
      const rfq_id = a.quote_id ?? a.rfq_id;
      if (a.from_asset != null && a.to_asset != null) return { rfq_id, from_asset: leg(a.from_asset, a.amount), to_asset: leg(a.to_asset) };
      return { rfq_id };
    },
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
      const out = data ?? { ok: true };
      return route.transformResponse ? route.transformResponse(out) : out;
    };
  }

  return bindKaleidoswapTools(handlers);
}
