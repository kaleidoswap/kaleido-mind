/**
 * Live BTC Map + Nominatim adapters for the CLI's merchant-finder skill.
 *
 * The mind never reaches the network — these are host-side fetchers injected
 * into createBtcMapToolSource as `fetch` + `location`.
 *
 *   - btcMapLiveFetch       hits api.btcmap.org/v2/elements (cached 24h to disk)
 *                           and filters client-side by haversine distance + query.
 *   - btcMapLiveLocation    geocodes a free-text address via Nominatim
 *                           (OpenStreetMap's, no API key needed). Optionally
 *                           returns a default "current" location.
 *
 * Cache: ~/.kaleido/btcmap-cache.json, refreshed every CACHE_TTL_MS.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type {
  LocationProvider,
  BtcMapFetch,
  BtcMapMerchant,
  LatLng,
} from '@kaleidorg/mind';

const CACHE_PATH = join(homedir(), '.kaleido', 'btcmap-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — BTC Map data changes slowly
const NOMINATIM_USER_AGENT = 'kaleido-mind-cli/0.1 (+https://kaleidoswap.com)';

/** Subset of the BTC Map v2 element schema we use. */
interface BtcMapElement {
  id: string;
  osm_json?: {
    lat?: number;
    lon?: number;
    bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
    tags?: Record<string, string>;
  };
  tags?: { category?: string };
  deleted_at?: string;
}

interface Cache { fetchedAt: number; elements: BtcMapElement[] }

async function loadCache(): Promise<Cache | null> {
  try {
    const raw = await readFile(CACHE_PATH, 'utf8');
    const data = JSON.parse(raw) as Cache;
    if (Date.now() - data.fetchedAt > CACHE_TTL_MS) return null;
    return data;
  } catch { return null; }
}

async function saveCache(elements: BtcMapElement[]): Promise<void> {
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), elements }));
}

/** Fetch the full BTC Map element list (≈thousands of rows) and cache it. */
async function fetchElements(): Promise<BtcMapElement[]> {
  const cached = await loadCache();
  if (cached) return cached.elements;
  const res = await fetch('https://api.btcmap.org/v2/elements');
  if (!res.ok) {
    throw new Error(`btcmap fetch failed: HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as BtcMapElement[];
  const live = data.filter((e) => !e.deleted_at);
  await saveCache(live).catch(() => { /* cache is best-effort */ });
  return live;
}

/** Get a point for an element — direct lat/lon, or the centre of its bbox. */
function elementCenter(e: BtcMapElement): { lat: number; lng: number } | null {
  const j = e.osm_json;
  if (!j) return null;
  if (j.lat != null && j.lon != null) return { lat: j.lat, lng: j.lon };
  if (j.bounds) {
    return {
      lat: (j.bounds.minlat + j.bounds.maxlat) / 2,
      lng: (j.bounds.minlon + j.bounds.maxlon) / 2,
    };
  }
  return null;
}

/** Haversine distance in meters between two points. */
function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const dφ = ((b.lat - a.lat) * Math.PI) / 180;
  const dλ = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** Map OSM payment/currency tags → our acceptedAssets vocabulary. */
function readAssets(tags: Record<string, string>): string[] {
  const out: string[] = [];
  if (tags['payment:lightning'] === 'yes' || tags['payment:lightning_contactless'] === 'yes') out.push('lightning');
  if (
    tags['payment:onchain'] === 'yes' ||
    tags['payment:bitcoin'] === 'yes' ||
    tags['currency:XBT'] === 'yes' ||
    tags['currency:BTC'] === 'yes'
  ) out.push('onchain');
  if (tags['currency:USDT'] === 'yes') out.push('usdt');
  if (tags['currency:XAUT'] === 'yes') out.push('xaut');
  // Default: BTC Map only lists Bitcoin-accepting places, so onchain is safe.
  if (out.length === 0) out.push('onchain');
  return out;
}

/** Pick a category from BTC Map's own tag or fall back to OSM amenity/tourism/shop. */
function readCategory(e: BtcMapElement, tags: Record<string, string>): string | undefined {
  return (
    e.tags?.category ||
    tags.amenity ||
    tags.tourism ||
    tags.shop ||
    undefined
  );
}

/** OSM addr:* tags → a human address string. */
function readAddress(tags: Record<string, string>): string | undefined {
  const parts = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ').trim();
  return parts || tags['addr:full'] || tags.address || undefined;
}

function toMerchant(e: BtcMapElement, center: { lat: number; lng: number }): BtcMapMerchant | null {
  const point = elementCenter(e);
  if (!point) return null;
  const tags = e.osm_json?.tags ?? {};
  const name = tags.name;
  if (!name) return null;

  return {
    id: e.id,
    name,
    category: readCategory(e, tags),
    address: readAddress(tags),
    city: tags['addr:city'],
    lat: point.lat,
    lng: point.lng,
    distance_m: Math.round(haversine(center, point)),
    acceptedAssets: readAssets(tags),
    phone: tags.phone,
    website: tags.website,
    opening_hours: tags.opening_hours,
  };
}

/**
 * BTC Map live fetcher. Loads (or refreshes) the cached element list,
 * filters by distance from the search centre, then by category/query.
 */
export const btcMapLiveFetch: BtcMapFetch = async (q) => {
  const elements = await fetchElements();
  const merchants: BtcMapMerchant[] = [];
  for (const e of elements) {
    const m = toMerchant(e, q.center);
    if (!m) continue;
    if ((m.distance_m ?? Infinity) > q.radiusMeters) continue;
    merchants.push(m);
  }

  let filtered = merchants;
  if (q.category) {
    const c = q.category.toLowerCase();
    filtered = filtered.filter((m) => (m.category ?? '').toLowerCase().includes(c));
  }
  if (q.query && q.query.trim().length >= 2) {
    const qq = q.query.toLowerCase();
    filtered = filtered.filter((m) => {
      const hay = `${m.name ?? ''} ${m.category ?? ''} ${m.address ?? ''}`.toLowerCase();
      return hay.includes(qq);
    });
  }

  return filtered.sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0)).slice(0, q.limit);
};

/**
 * Live geocoder + optional default "current" location for the CLI.
 *
 * The CLI has no GPS, so:
 *   - `getCurrent` returns `defaultLocation` if one is configured (e.g.
 *     KALEIDO_DEFAULT_LOCATION="Lugano"); otherwise null → the core source
 *     returns a clean "no location" error (no offline fallback).
 *   - `geocode` hits Nominatim (OSM's free geocoder). User agent set per
 *     Nominatim usage policy.
 */
export function btcMapLiveLocation(defaultLocation?: LatLng): LocationProvider {
  return {
    async getCurrent() {
      return defaultLocation ?? null;
    },
    async geocode(address) {
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.searchParams.set('q', address);
      url.searchParams.set('format', 'json');
      url.searchParams.set('limit', '1');
      try {
        const res = await fetch(url.toString(), {
          headers: { 'user-agent': NOMINATIM_USER_AGENT },
        });
        if (!res.ok) return null;
        const arr = (await res.json()) as Array<{ lat: string; lon: string }>;
        if (!arr.length) return null;
        const lat = Number(arr[0]!.lat);
        const lng = Number(arr[0]!.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return { lat, lng };
      } catch {
        return null;
      }
    },
  };
}

/**
 * Resolve a default location from env (`KALEIDO_DEFAULT_LOCATION`).
 * Set to a free-text address or a "lat,lng" pair. Returns undefined when
 * unset — the source then returns a "could not determine your location"
 * error for "near me" queries (no offline fallback).
 */
export async function defaultLocationFromEnv(): Promise<LatLng | undefined> {
  const v = process.env.KALEIDO_DEFAULT_LOCATION;
  if (!v) return undefined;
  // Accept "lat,lng" directly.
  const m = v.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) {
    return { lat: Number(m[1]), lng: Number(m[2]), label: v, precise: false };
  }
  // Otherwise geocode it via Nominatim on startup.
  const geo = btcMapLiveLocation();
  const pt = await geo.geocode?.(v);
  if (pt) return { ...pt, label: v, precise: false };
  return undefined;
}
