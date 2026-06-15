/**
 * BTC Map tool source — exposes `find_merchant_locations` so the agent can
 * answer "where can I spend Bitcoin near me?" using the SAME tool name on
 * every surface.
 *
 *   - mobile  → injects device GPS + a live BTC Map fetch
 *   - desktop → injects a live fetch (or a server-side cache)
 *
 * Pure data + orchestration — NO network in core. The host injects the
 * `location` resolver and the `fetch` adapter. Without them the tool returns
 * a clear error: there is NO offline / sample fallback (intentional — fake
 * data is worse than a clean failure that tells the user what's wrong).
 *
 * The result shape mirrors what rate's host returns today, so a mobile host
 * can swap its bespoke merchant tools for this factory verbatim.
 */

import type { ToolDef } from '../types.js';
import type { ToolSource } from '../tools/source.js';
import type { Merchant } from './merchants.js';

const FIND = 'find_merchant_locations';

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
 * Node typically doesn't. When the host can't resolve a location (no GPS, no
 * geocoder, or `near_address` won't geocode), the tool returns a clean
 * `success:false` error instead of falling back to fake data.
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
  /** Default for `limit` when the caller doesn't set one. Default 10. */
  k?: number;
}

/** Clamp a value to a numeric range, returning the default when input is bad. */
function clamp(n: unknown, lo: number, hi: number, dflt: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, v));
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

/**
 * Build a ToolSource exposing `find_merchant_locations`.
 *
 * Resolution order:
 *   1. `near_address` provided → opts.location.geocode → opts.fetch (live)
 *   2. opts.location.getCurrent → opts.fetch (live)
 *
 * Any step that fails returns `{success:false, error}` with a message that
 * tells the user (and the model) what's actually wrong — no fake-data
 * fallback. Either we have a real merchant list or we say we don't.
 */
export function createBtcMapToolSource(opts: BtcMapToolOptions = {}): ToolSource {
  const defaultLimit = opts.k ?? 10;

  const find: ToolDef = {
    name: FIND,
    description:
      "Find Bitcoin-accepting merchants near the user using live BTC Map data " +
      "and the device's real location when available. Use when the user wants " +
      'merchants, shops, restaurants, cafes, bars, ATMs, or places to spend ' +
      'Bitcoin nearby. Pass ONLY the fields the user actually named — do not ' +
      'invent constraints. "where can I spend btc in Lugano" → ' +
      '`{near_address:"Lugano"}` and NOTHING ELSE (no `category`, no ' +
      '`radius_km`). Adding a category you guessed will exclude most results.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'OPTIONAL — a name or food type the user literally named (e.g. "coffee", "pizza"). OMIT for "spend btc"/"merchants"/"places".' },
        category: { type: 'string', description: 'OPTIONAL — set ONLY if the user named a specific kind of venue (restaurant, cafe, bar, shop, grocery, lodging, atm). NEVER guess from context. OMIT for generic "spend btc" / "merchants" / "places".' },
        near_address: { type: 'string', description: 'City or address to search around when the user names a location. e.g. "Lugano", "Lisbon".' },
        radius_km: { type: 'number', description: 'OPTIONAL — search radius in km (0.25–50). OMIT entirely unless the user explicitly named a distance ("within 2 km"). The default (5) is already applied server-side.' },
        limit: { type: 'number', description: 'OPTIONAL — max results (1–20, default 10). Omit unless the user named a count.' },
      },
    },
  };

  async function resolveCenter(near_address: string | undefined): Promise<LatLng | null> {
    if (!opts.location) return null;
    if (near_address && near_address.trim().length >= 2 && opts.location.geocode) {
      try {
        const pt = await opts.location.geocode(near_address);
        if (pt) return { ...pt, label: near_address, precise: false };
      } catch {
        /* geocode failed — fall through to getCurrent */
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

    // Live path requires BOTH a location resolver and a fetch adapter — they
    // are host-injected. Without either, the tool can't produce real merchant
    // data, and we refuse to invent.
    if (!opts.fetch) {
      return {
        success: false,
        error:
          'Merchant search is unavailable: the host has not injected a BTC Map fetch adapter. ' +
          'No offline / sample data is used — connect a fetcher or try again later.',
      };
    }
    const center = await resolveCenter(near_address);
    if (!center) {
      return {
        success: false,
        error: near_address
          ? `Could not locate "${near_address}". Check the spelling or try a nearby city.`
          : 'Could not determine your location. Pass `near_address` (a city or address) to search a specific area.',
      };
    }

    let merchants: BtcMapMerchant[];
    try {
      merchants = await opts.fetch({
        center: { lat: center.lat, lng: center.lng },
        radiusMeters,
        query,
        category,
        limit,
      });
    } catch (e) {
      return {
        success: false,
        error: `BTC Map fetch failed: ${(e as Error)?.message ?? String(e)}.`,
      };
    }

    const where = center.label || (center.precise ? 'your location' : 'the requested area');
    return {
      success: true,
      source: 'btcmap',
      precise_location: !!center.precise,
      center: { lat: center.lat, lng: center.lng },
      merchants: merchants.map(row),
      total_found: merchants.length,
      message:
        merchants.length > 0
          ? `Found ${merchants.length} Bitcoin merchant${merchants.length === 1 ? '' : 's'} near ${where}${query ? ` matching "${query}"` : ''}.`
          : `No Bitcoin merchants found within ${radius_km} km of ${where}. Try widening the radius.`,
    };
  }

  async function execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === FIND) return findLocations(args);
    throw new Error(`btc-map: unknown tool "${name}"`);
  }

  return {
    id: 'btc-map',
    listTools: () => [find],
    has: (name) => name === FIND,
    execute,
  };
}
