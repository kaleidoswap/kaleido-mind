/**
 * Bitrefill REST tool source for the CLI — fetch-based handlers that implement
 * the canonical `bitrefill_*` contract from `@kaleidorg/mind`.
 *
 * The Bitrefill MCP path requires interactive OAuth (a headless CLI can't do
 * that) and the npm CLI path requires magic-link email auth. REST API with a
 * Personal Bearer token is the only purchase channel that works headless out
 * of the box — so this adapter wraps the v2 REST endpoints documented at
 * <https://docs.bitrefill.com/reference> and exposes them under the contract.
 *
 * Body shapes mirror the REST quickstart:
 *   POST /v2/invoices   { products:[{product_id,package_id,quantity}],
 *                         payment_method, auto_pay?, refund_address?, ... }
 *   GET  /v2/products/search?q=...&country=...&limit=...
 *   GET  /v2/products/{id}
 *   GET  /v2/accounts/balance
 *   GET  /v2/invoices/{id}
 *   GET  /v2/orders/{id}
 *
 * Auth: Bearer <BITREFILL_API_KEY> (Personal tier). Business tier (Basic auth
 * with API_ID:API_SECRET) would just swap the Authorization header — the body
 * shapes are unchanged.
 */

import {
  bindBitrefillTools,
  type InProcessToolSource,
  type BitrefillHandler,
} from '@kaleidorg/mind';

export interface BitrefillHttpOptions {
  /** Bitrefill REST base. No trailing slash. Default `https://api.bitrefill.com/v2`. */
  baseUrl?: string;
  /** Personal API key (Bearer token). Required for any real call. */
  apiKey: string;
  /** Override `fetch` for testing. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Optional Business-tier auth — if both id and secret are set, the adapter
   * sends `Authorization: Basic base64(id:secret)` and ignores `apiKey`.
   */
  apiId?: string;
  apiSecret?: string;
}

interface Route {
  method: 'GET' | 'POST';
  /** Path can contain `{key}` placeholders filled from args. */
  path: string;
  body?: (args: Record<string, unknown>) => unknown;
  query?: (args: Record<string, unknown>) => Record<string, string>;
}

function clamp(x: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(x);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

const ROUTES: Record<string, Route> = {
  bitrefill_search: {
    method: 'GET',
    path: '/products/search',
    query: (a) => {
      const q: Record<string, string> = { q: String(a.query ?? '') };
      if (a.country) q.country = String(a.country);
      q.limit = String(clamp(a.limit, 1, 25, 10));
      return q;
    },
  },
  bitrefill_get_product: {
    method: 'GET',
    path: '/products/{product_id}',
  },
  bitrefill_get_balance: {
    method: 'GET',
    path: '/accounts/balance',
  },
  bitrefill_create_invoice: {
    method: 'POST',
    path: '/invoices',
    body: (a) => {
      const out: Record<string, unknown> = {
        products: Array.isArray(a.products) ? a.products : [],
        payment_method: String(a.payment_method ?? 'balance'),
      };
      if (a.auto_pay !== undefined) out.auto_pay = !!a.auto_pay;
      if (a.refund_address != null) out.refund_address = String(a.refund_address);
      if (a.email != null) out.email = String(a.email);
      if (a.webhook_url != null) out.webhook_url = String(a.webhook_url);
      return out;
    },
  },
  bitrefill_get_invoice: {
    method: 'GET',
    path: '/invoices/{invoice_id}',
  },
  bitrefill_get_order: {
    method: 'GET',
    path: '/orders/{order_id}',
  },
};

function fillPath(path: string, args: Record<string, unknown>): string {
  return path.replace(/\{(\w+)\}/g, (_, k) => {
    const v = args[k];
    if (v === undefined || v === null || v === '') {
      throw new Error(`bitrefill: missing path arg "${k}"`);
    }
    return encodeURIComponent(String(v));
  });
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Build an InProcessToolSource that proxies every Bitrefill tool over REST. */
export function buildBitrefillToolSource(opts: BitrefillHttpOptions): InProcessToolSource {
  const fx = opts.fetchImpl ?? fetch;
  const base = (opts.baseUrl ?? 'https://api.bitrefill.com/v2').replace(/\/+$/, '');

  // Pre-compute the auth header. Business tier (API_ID:API_SECRET → Basic auth)
  // wins when both halves are present; otherwise Personal Bearer.
  let authHeader: string | null = null;
  if (opts.apiId && opts.apiSecret) {
    const token = Buffer.from(`${opts.apiId}:${opts.apiSecret}`).toString('base64');
    authHeader = `Basic ${token}`;
  } else if (opts.apiKey) {
    authHeader = `Bearer ${opts.apiKey}`;
  }

  const handlers: Record<string, BitrefillHandler> = {};
  for (const [name, route] of Object.entries(ROUTES)) {
    handlers[name] = async (args) => {
      const a = args ?? {};
      const url = new URL(base + fillPath(route.path, a));
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (authHeader) headers.authorization = authHeader;

      const init: RequestInit = { method: route.method, headers };
      if (route.method === 'GET') {
        const params = route.query ? route.query(a) : {};
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      } else {
        init.body = JSON.stringify(route.body ? route.body(a) : a);
      }

      const res = await fx(url.toString(), init);
      const text = await res.text();
      const data = text ? safeJson(text) : null;
      if (!res.ok) {
        throw new Error(
          `bitrefill ${name} failed: HTTP ${res.status} ${res.statusText}` +
            (typeof text === 'string' && text ? ` — ${text.slice(0, 240)}` : ''),
        );
      }
      // Bitrefill v2 wraps responses as `{ data: ... }`; unwrap for the model.
      if (data && typeof data === 'object' && 'data' in (data as any)) {
        return (data as any).data;
      }
      return data ?? { ok: true };
    };
  }

  return bindBitrefillTools(handlers);
}
