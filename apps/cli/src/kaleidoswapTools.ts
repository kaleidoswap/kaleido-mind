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

/**
 * Per-asset precision used by the maker's REST API — what its `amount` fields
 * are denominated in. Verified live via `/api/v1/market/assets`. The maker uses
 * sub-sat resolution for BTC (precision 11 ≈ msats), so a raw "100000" sent
 * for BTC is interpreted as 100 sats unless we scale.
 */
const MAKER_PRECISION: Record<string, number> = {
  BTC: 11,
  USDT: 6,
  XAUT: 9,
};

/**
 * Per-asset "user-natural" precision — the unit the user actually types in.
 * BTC users count in sats (10⁻⁸ BTC); USDT/XAUT users count in whole units.
 *
 * The host scales an incoming user amount by 10^(MAKER_PRECISION − USER) so
 * the maker receives the right magnitude. Discovered in milestone 1 testing:
 * "100,000 sats" without this scaling came back quoted for ~100 sats, off by
 * 1000×. With scaling the maker sees 100,000,000 (= 100,000 sats × 10³).
 */
const USER_NATURAL_PRECISION: Record<string, number> = {
  BTC: 8,
  USDT: 0,
  XAUT: 0,
};

/**
 * Scale a user-natural amount → maker smallest-unit integer.
 *
 * Anti-double-scale: if amount ≥ 10^MAKER_PRECISION (= 1 whole asset in
 * smallest units), assume the caller already pre-scaled (e.g. the model
 * echoed a smallest-unit value from a prior response) and pass through.
 * The threshold sits well above any realistic user-natural input.
 */
function scaleAmount(asset: string, amount: number): number {
  if (!Number.isFinite(amount)) return amount;
  const mp = MAKER_PRECISION[asset];
  const up = USER_NATURAL_PRECISION[asset];
  if (mp == null || up == null) return Math.round(amount);
  if (amount >= 10 ** mp) return Math.round(amount);
  return Math.round(amount * 10 ** (mp - up));
}

/**
 * Format a maker-smallest-unit amount back into the user's natural unit.
 *   BTC  → "{N} sats"  (amount ÷ 10^(maker_precision − 8))
 *   USDT → "{N} USDT"  (amount ÷ 10^maker_precision)
 *   XAUT → "{N} XAUT"  (amount ÷ 10^maker_precision)
 *
 * Mirrors scaleAmount on the way out — the model reads these strings verbatim
 * and never does precision math itself.
 */
/** Display digits per asset — how many fractional places to show. */
function displayDigits(asset: string): number {
  if (asset === 'BTC') return 0; // sats are integer
  if (asset === 'USDT' || asset === 'XAUT') return 6; // stablecoin / gold sub-unit
  return 4; // unknown assets — sensible default
}

function formatUserNatural(assetTicker: unknown, amount: unknown, makerPrecision: unknown): string | undefined {
  const a = Number(amount);
  const mp = Number(makerPrecision);
  if (!Number.isFinite(a) || !Number.isFinite(mp)) return undefined;
  const id = String(assetTicker ?? '').toUpperCase();
  const up = USER_NATURAL_PRECISION[id] ?? 0;
  const value = a / 10 ** (mp - up);
  const unit = id === 'BTC' ? 'sats' : id;
  // toLocaleString strips trailing zeros up to maximumFractionDigits, so the
  // output is "0.65 USDT" or "0.649150 USDT" but never "0.000000 USDT".
  return `${value.toLocaleString('en-US', { maximumFractionDigits: displayDigits(id) })} ${unit}`.trim();
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
  return {
    ...d,
    from_amount_display: formatUserNatural(from.ticker ?? from.asset_id, from.amount, from.precision),
    to_amount_display: formatUserNatural(to.ticker ?? to.asset_id, to.amount, to.precision),
    fee_display: formatUserNatural(fee.fee_asset, fee.final_fee, fee.fee_asset_precision),
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
  if (amount != null && amount !== '') out.amount = scaleAmount(id, Number(amount));
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
