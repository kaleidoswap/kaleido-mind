/**
 * BTC Map tool source — exposes `find_merchant_locations` and
 * `get_merchant_info` so the agent can answer "where can I spend Bitcoin
 * near me?" using the SAME tool names on every surface.
 *
 *   - mobile  → injects device GPS + a live BTC Map fetch
 *   - desktop → injects a live fetch (or a server-side cache)
 *   - eval / playground → no injection, falls back to the bundled offline list
 *
 * Pure data + orchestration — NO network in core. The host injects the
 * `location` resolver and the `fetch` adapter; without them the source still
 * runs against an offline `Merchant[]` so the skill is never dead on arrival.
 *
 * The result shape mirrors what rate's host returns today, so a mobile host
 * can swap its bespoke merchant tools for this factory verbatim.
 */

import type { ToolDef } from '../types.js';
import type { ToolSource } from '../tools/source.js';
import type { Merchant } from './merchants.js';

const FIND = 'find_merchant_locations';
const INFO = 'get_merchant_info';

/** A geographic point + optional human label. */
export interface LatLng {
  lat: number;
  lng: number;
  /** Optional "Lugano, Switzerland" style label for messages. */
  label?: string;
  /** True when the location came from the device GPS, false for a default/fallback. */
  precise?: boolean;
}

/**
 * Host-injected location resolver. Core is platform-agnostic — RN has GPS,
 * Node typically doesn't. When omitted, `find_merchant_locations` falls back
 * to the offline merchant list.
 */
export interface LocationProvider {
  /** Resolve "near me" — the device location, or null if unavailable. */
  getCurrent(): Promise<LatLng | null>;
  /** Optional: geocode a free-text address ("Via Pessina 12, Lugano"). */
  geocode?(address: string): Promise<LatLng | null>;
}

/** A merchant returned by a live BTC Map fetch. */
export interface BtcMapMerchant extends Merchant {
  /** Distance from the search centre, metres. */
  distance_m?: number;
  /** Free-text contact extras the model can surface to the user. */
  phone?: string;
  website?: string;
  opening_hours?: string;
}

/**
 * Host-injected live-fetch adapter. Receives a normalized query and returns
 * the matching merchants. The host is responsible for the HTTP call, caching,
 * and any rate limits — core never reaches the network.
 */
export type BtcMapFetch = (q: {
  center: { lat: number; lng: number };
  radiusMeters: number;
  query?: string;
  category?: string;
  limit: number;
}) => Promise<BtcMapMerchant[]>;

export interface BtcMapToolOptions {
  /** Resolve "near me" + geocode an address. RN hosts inject Expo Location. */
  location?: LocationProvider;
  /** Hit a live BTC Map (or your own cache). Host-injected — no network in core. */
  fetch?: BtcMapFetch;
  /** Offline list used when no location/fetch is available. Defaults to BTC_MAP_SAMPLE. */
  offlineMerchants?: Merchant[];
  /** Default for `limit` when the caller doesn't set one. Default 10. */
  k?: number;
}

/** A tiny, hand-curated sample so the skill works offline out of the box. */
export const BTC_MAP_SAMPLE: Merchant[] = [
  {
    id: 'lugano-bitcoinpeople-cafe',
    name: 'Bitcoin People Café',
    category: 'cafe',
    address: 'Via Pessina 12',
    city: 'Lugano',
    lat: 46.0037,
    lng: 8.9511,
    acceptedAssets: ['lightning', 'onchain'],
    description: 'Specialty espresso bar; Plan ₿ Lugano partner.',
  },
  {
    id: 'lugano-bistro-libertine',
    name: 'Bistro Libertine',
    category: 'restaurant',
    address: 'Piazza della Riforma 3',
    city: 'Lugano',
    lat: 46.004,
    lng: 8.952,
    acceptedAssets: ['lightning', 'usdt', 'onchain'],
    description: 'Italian-Swiss bistro, lunch + dinner. Accepts Tether on Liquid.',
  },
  {
    id: 'lugano-bookshop-volta',
    name: 'Libreria Volta',
    category: 'shop',
    address: 'Via Cattedrale 8',
    city: 'Lugano',
    lat: 46.0055,
    lng: 8.9499,
    acceptedAssets: ['lightning'],
    description: 'Independent bookshop; Italian, English and German titles.',
  },
  {
    id: 'lisbon-meson-andaluz',
    name: 'Mesón Andaluz',
    category: 'restaurant',
    address: 'Rua das Flores 42',
    city: 'Lisbon',
    lat: 38.71,
    lng: -9.143,
    acceptedAssets: ['lightning', 'onchain'],
    description: 'Andalusian tapas in Chiado. Bitcoin accepted since 2022.',
  },
  {
    id: 'lisbon-surf-bitcoin',
    name: 'Surf & Sats',
    category: 'shop',
    address: 'Av. da Liberdade 180',
    city: 'Lisbon',
    lat: 38.7211,
    lng: -9.1466,
    acceptedAssets: ['lightning'],
    description: 'Surfboard rental and lessons in Costa da Caparica.',
  },
  {
    id: 'sansalvador-elzonte-hope',
    name: 'Hope House El Zonte',
    category: 'cafe',
    address: 'Calle Principal',
    city: 'El Zonte',
    lat: 13.492,
    lng: -89.4395,
    acceptedAssets: ['lightning', 'onchain'],
    description: 'Bitcoin Beach hub. Coffee, community, and a Lightning ATM.',
  },
  {
    id: 'sansalvador-elzonte-garten',
    name: 'Garten Restaurante',
    category: 'restaurant',
    address: 'Bitcoin Beach',
    city: 'El Zonte',
    lat: 13.4925,
    lng: -89.438,
    acceptedAssets: ['lightning'],
    description: 'Beachfront restaurant, full Bitcoin payments since 2021.',
  },
  {
    id: 'nyc-pubkey',
    name: 'PubKey',
    category: 'bar',
    address: '85 Washington Pl',
    city: 'New York',
    lat: 40.732,
    lng: -73.999,
    acceptedAssets: ['lightning', 'onchain'],
    description: 'Bitcoin bar in Greenwich Village — meetups, Lightning tap.',
  },
  {
    id: 'prague-paralelni-polis',
    name: 'Paralelní Polis',
    category: 'cafe',
    address: 'Dělnická 43',
    city: 'Prague',
    lat: 50.105,
    lng: 14.448,
    acceptedAssets: ['lightning', 'onchain', 'monero'],
    description: 'Crypto-only café and hackerspace — no fiat accepted, ever.',
  },
  {
    id: 'amsterdam-bitcoin-embassy',
    name: 'Bitcoin Embassy Amsterdam',
    category: 'cafe',
    address: 'Nieuwezijds Voorburgwal 162',
    city: 'Amsterdam',
    lat: 52.374,
    lng: 4.893,
    acceptedAssets: ['lightning', 'onchain'],
    description: 'Co-working café and meetup hub, Lightning tap on draft beer.',
  },
];

/** Clamp a value to a numeric range, returning the default when input is bad. */
function clamp(n: unknown, lo: number, hi: number, dflt: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, v));
}

/** Substring scoring used by the offline fallback (matches the old behavior). */
function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) return 1;
  let hits = 0;
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      hits++;
      qi++;
    }
  }
  return hits / q.length;
}

/** Map a Merchant → the response row the model sees (stable for rate parity). */
function row(m: BtcMapMerchant) {
  return {
    id: m.id,
    name: m.name,
    address: m.address,
    category: m.category,
    lat: m.lat,
    lng: m.lng,
    distance_m: m.distance_m,
    phone: m.phone,
    website: m.website,
    opening_hours: m.opening_hours,
    accepts_bitcoin: m.acceptedAssets?.includes('onchain') ?? true,
    accepts_lightning: m.acceptedAssets?.includes('lightning') ?? true,
  };
}

/** Offline search: substring + optional category over the bundled list. */
function searchOffline(
  merchants: Merchant[],
  query: string | undefined,
  category: string | undefined,
  limit: number,
): Merchant[] {
  let filtered = merchants;
  if (category) {
    const c = category.toLowerCase().trim();
    filtered = filtered.filter((m) => (m.category ?? '').toLowerCase() === c);
  }
  const q = (query ?? '').trim();
  if (q.length >= 2) {
    filtered = filtered
      .map((m) => {
        const hay = `${m.name ?? ''} ${m.description ?? ''} ${m.address ?? ''} ${m.city ?? ''}`;
        const score =
          fuzzyScore(q, m.name ?? '') * 3 +
          fuzzyScore(q, m.address ?? '') * 2 +
          fuzzyScore(q, hay) * 1;
        return { m, score };
      })
      .filter((x) => x.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.m);
  }
  return filtered.slice(0, limit);
}

/**
 * Build a ToolSource exposing `find_merchant_locations` + `get_merchant_info`.
 *
 * Resolution order for `find_merchant_locations`:
 *   1. `near_address` provided → opts.location.geocode → opts.fetch (live)
 *   2. opts.location.getCurrent → opts.fetch (live)
 *   3. fall through to offline substring search over opts.offlineMerchants
 *
 * Any step that fails silently falls through to the next, so the skill is
 * always answerable.
 */
export function createBtcMapToolSource(opts: BtcMapToolOptions = {}): ToolSource {
  const offline = opts.offlineMerchants ?? BTC_MAP_SAMPLE;
  const defaultLimit = opts.k ?? 10;

  const find: ToolDef = {
    name: FIND,
    description:
      "Find Bitcoin-accepting merchants near the user using live BTC Map data " +
      "and the device's real location when available. Use when the user wants " +
      'merchants, shops, restaurants, cafes, bars, ATMs, or places to spend ' +
      'Bitcoin nearby. Pass ONLY the fields the user actually named — do not ' +
      'invent constraints (e.g. omit `query` when they just say "near me").',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional filter for merchant name or type, e.g. "coffee"' },
        category: { type: 'string', description: 'restaurant | cafe | bar | shop | grocery | lodging | atm' },
        near_address: { type: 'string', description: 'Address/city to search around instead of the current location' },
        radius_km: { type: 'number', description: 'Search radius in km (0.25–50, default 5)' },
        limit: { type: 'number', description: 'Max number of results (1–20, default 10)' },
      },
    },
  };

  const info: ToolDef = {
    name: INFO,
    description:
      'Get detailed information about one specific merchant by id or name — ' +
      'full address, accepted assets, contact details. Use after ' +
      'find_merchant_locations when the user asks for more on a specific result.',
    parameters: {
      type: 'object',
      properties: {
        merchant_id: { type: 'string', description: 'Merchant id from find_merchant_locations (string or number)' },
        merchant_name: { type: 'string', description: 'Merchant name (used when id is unknown)' },
      },
    },
  };

  async function tryLive(
    center: LatLng,
    radiusMeters: number,
    query: string | undefined,
    category: string | undefined,
    limit: number,
  ): Promise<BtcMapMerchant[] | null> {
    if (!opts.fetch) return null;
    try {
      return await opts.fetch({
        center: { lat: center.lat, lng: center.lng },
        radiusMeters,
        query,
        category,
        limit,
      });
    } catch {
      return null;
    }
  }

  async function resolveCenter(near_address: string | undefined): Promise<LatLng | null> {
    if (!opts.location) return null;
    if (near_address && near_address.trim().length >= 2 && opts.location.geocode) {
      try {
        const pt = await opts.location.geocode(near_address);
        if (pt) return { ...pt, label: near_address, precise: false };
      } catch {
        /* fall through */
      }
    }
    try {
      return await opts.location.getCurrent();
    } catch {
      return null;
    }
  }

  async function findLocations(args: Record<string, unknown>): Promise<unknown> {
    const query = args.query ? String(args.query) : undefined;
    const category = args.category ? String(args.category) : undefined;
    const near_address = args.near_address ? String(args.near_address) : undefined;
    const radius_km = clamp(args.radius_km, 0.25, 50, 5);
    const limit = clamp(args.limit, 1, 20, defaultLimit);
    const radiusMeters = radius_km * 1000;

    // 1 + 2. Try the live path when we can.
    const center = await resolveCenter(near_address);
    if (center) {
      const live = await tryLive(center, radiusMeters, query, category, limit);
      if (live) {
        const where = center.label || (center.precise ? 'your location' : 'the default location');
        return {
          success: true,
          source: 'btcmap',
          precise_location: !!center.precise,
          center: { lat: center.lat, lng: center.lng },
          merchants: live.map(row),
          total_found: live.length,
          message:
            live.length > 0
              ? `Found ${live.length} Bitcoin merchant${live.length === 1 ? '' : 's'} near ${where}${query ? ` matching "${query}"` : ''}.`
              : `No Bitcoin merchants found within ${radius_km} km of ${where}. Try widening the radius.`,
        };
      }
    }

    // 3. Offline fallback.
    const found = searchOffline(offline, query, category, limit);
    return {
      success: true,
      source: 'offline',
      precise_location: false,
      merchants: found.map(row),
      total_found: found.length,
      message:
        found.length > 0
          ? `Showing ${found.length} merchant${found.length === 1 ? '' : 's'} from the offline list${query ? ` matching "${query}"` : ''}.`
          : `No merchants in the offline list matched${query ? ` "${query}"` : ''}. The host hasn't injected a live BTC Map fetch.`,
    };
  }

  async function getInfo(args: Record<string, unknown>): Promise<unknown> {
    const idArg = args.merchant_id;
    const nameArg = args.merchant_name ? String(args.merchant_name).trim() : '';
    let m: Merchant | undefined;
    if (idArg !== undefined && idArg !== null && idArg !== '') {
      const want = String(idArg);
      m = offline.find((x) => String(x.id) === want);
    }
    if (!m && nameArg.length >= 2) {
      const q = nameArg.toLowerCase();
      m =
        offline.find((x) => (x.name ?? '').toLowerCase() === q) ??
        offline
          .map((x) => ({ x, score: fuzzyScore(q, (x.name ?? '').toLowerCase()) }))
          .filter((r) => r.score > 0.5)
          .sort((a, b) => b.score - a.score)[0]?.x;
    }
    if (!m) {
      const suggestions = nameArg
        ? offline
            .map((x) => ({ name: x.name ?? '', score: fuzzyScore(nameArg.toLowerCase(), (x.name ?? '').toLowerCase()) }))
            .filter((r) => r.score > 0.3)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map((r) => r.name)
        : [];
      return {
        success: false,
        error: `Could not find merchant${nameArg ? ` "${nameArg}"` : idArg !== undefined ? ` with id ${idArg}` : ''}.`,
        suggestions: suggestions.length ? suggestions : undefined,
      };
    }
    return { success: true, merchant: { ...row(m as BtcMapMerchant), city: m.city } };
  }

  async function execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === FIND) return findLocations(args);
    if (name === INFO) return getInfo(args);
    throw new Error(`btc-map: unknown tool "${name}"`);
  }

  return {
    id: 'btc-map',
    listTools: () => [find, info],
    has: (name) => name === FIND || name === INFO,
    execute,
  };
}
