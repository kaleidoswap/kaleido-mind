/**
 * BTC Map tool source — exposes `find_merchants` and `get_merchant_info` so
 * the agent can answer "where can I spend Bitcoin near me?" out of the box.
 *
 * Backed by an injected `Merchant[]` (default: BTC_MAP_SAMPLE) so a host can
 * swap in a live `api.btcmap.org` fetch, a cached snapshot, or the user's
 * favourites without touching the tool contract.
 *
 * Search is intentionally simple — substring + optional city/category filter
 * — so the demo runs with zero embeddings. For a large corpus, wrap the same
 * data with `merchantsToDocuments` + Retriever instead.
 */

import type { ToolDef } from '../types.js';
import type { ToolSource } from '../tools/source.js';
import type { Merchant } from './merchants.js';

const FIND = 'find_merchants';
const INFO = 'get_merchant_info';

export interface BtcMapToolOptions {
  /** Max results returned by find_merchants (default 5). */
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
    lat: 46.0040,
    lng: 8.9520,
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
    lat: 38.7100,
    lng: -9.1430,
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
    lat: 13.4920,
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
    lng: -89.4380,
    acceptedAssets: ['lightning'],
    description: 'Beachfront restaurant, full Bitcoin payments since 2021.',
  },
  {
    id: 'nyc-pubkey',
    name: 'PubKey',
    category: 'bar',
    address: '85 Washington Pl',
    city: 'New York',
    lat: 40.7320,
    lng: -73.9990,
    acceptedAssets: ['lightning', 'onchain'],
    description: 'Bitcoin bar in Greenwich Village — meetups, Lightning tap.',
  },
  {
    id: 'prague-paralelni-polis',
    name: 'Paralelní Polis',
    category: 'cafe',
    address: 'Dělnická 43',
    city: 'Prague',
    lat: 50.1050,
    lng: 14.4480,
    acceptedAssets: ['lightning', 'onchain', 'monero'],
    description: 'Crypto-only café and hackerspace — no fiat accepted, ever.',
  },
  {
    id: 'amsterdam-bitcoin-embassy',
    name: 'Bitcoin Embassy Amsterdam',
    category: 'cafe',
    address: 'Nieuwezijds Voorburgwal 162',
    city: 'Amsterdam',
    lat: 52.3740,
    lng: 4.8930,
    acceptedAssets: ['lightning', 'onchain'],
    description: 'Co-working café and meetup hub, Lightning tap on draft beer.',
  },
];

/**
 * Search merchants. `city` and `category` are HARD filters; `query` is a SOFT
 * ranker — it orders the filtered candidates but never empties them. This keeps
 * a small model from zeroing out a valid "merchants in Lugano" result by also
 * passing a query term (e.g. "coffee") that happens not to substring-match.
 */
function searchMerchants(
  merchants: Merchant[],
  query: string,
  city?: string,
  category?: string,
  k = 5,
): Merchant[] {
  const q = query.toLowerCase().trim();
  const c = city?.toLowerCase().trim();
  const cat = category?.toLowerCase().trim();

  // Hard filters first.
  const candidates = merchants.filter((m) => {
    if (c && (m.city ?? '').toLowerCase() !== c) return false;
    if (cat && (m.category ?? '').toLowerCase() !== cat) return false;
    return true;
  });

  // No query → return the filtered set in natural order.
  if (!q) return candidates.slice(0, k);

  // Soft ranking by substring relevance.
  const scored = candidates
    .map((m) => {
      const hay = `${m.name ?? ''} ${m.description ?? ''} ${m.category ?? ''} ${m.city ?? ''}`.toLowerCase();
      let score = 0;
      if (hay.includes(q)) score += 5;
      for (const w of q.split(/\s+/).filter((w) => w.length > 2)) {
        if (hay.includes(w)) score += 1;
      }
      return { m, score };
    })
    .sort((a, b) => b.score - a.score);

  // If a city/category filter narrowed things, never return empty just because
  // the query didn't match — fall back to the filtered candidates.
  const anyMatch = scored.some((x) => x.score > 0);
  if (!anyMatch && (c || cat)) return candidates.slice(0, k);

  // Pure free-text search with no filter: only return real matches (empty is
  // the honest answer when nothing matches).
  const kept = c || cat ? scored : scored.filter((x) => x.score > 0);
  return kept.slice(0, k).map((x) => x.m);
}

/**
 * Build a ToolSource exposing `find_merchants` + `get_merchant_info`.
 * Inject your own merchant list, or omit to use BTC_MAP_SAMPLE.
 */
export function createBtcMapToolSource(
  merchants: Merchant[] = BTC_MAP_SAMPLE,
  opts: BtcMapToolOptions = {},
): ToolSource {
  const find: ToolDef = {
    name: FIND,
    description:
      'Find merchants that accept Bitcoin from the BTC Map directory. ' +
      'Use when the user asks where they can spend Bitcoin or discover places. ' +
      'Pass ONLY the fields the user actually named. If they just give a city ' +
      '("spend btc in Lugano"), pass city alone and leave query/category empty. ' +
      'Only set query when the user names a specific thing (e.g. "tapas"), and ' +
      'category only when they name a type (cafe/restaurant/bar/shop).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A specific thing the user named, or omit' },
        city: { type: 'string', description: 'Restrict to a city, e.g. "Lugano"' },
        category: { type: 'string', description: 'cafe | restaurant | bar | shop — only if the user named a type' },
        k: { type: 'number', description: 'Max results (default 5)' },
      },
    },
  };

  const info: ToolDef = {
    name: INFO,
    description:
      'Get full details for one merchant by its id — address, accepted assets, ' +
      'description, coordinates. Use after find_merchants to deep-link or pin a place.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Merchant id from find_merchants' } },
      required: ['id'],
    },
  };

  async function execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === FIND) {
      const k = Number(args.k) > 0 ? Number(args.k) : (opts.k ?? 5);
      const hits = searchMerchants(
        merchants,
        String(args.query ?? ''),
        args.city ? String(args.city) : undefined,
        args.category ? String(args.category) : undefined,
        k,
      );
      if (hits.length === 0) return { results: [], note: 'No merchants matched.' };
      return {
        results: hits.map((m) => ({
          id: m.id,
          name: m.name,
          category: m.category,
          city: m.city,
          address: m.address,
          accepts: m.acceptedAssets,
          lat: m.lat,
          lng: m.lng,
        })),
      };
    }
    if (name === INFO) {
      const id = String(args.id ?? '');
      const m = merchants.find((x) => x.id === id);
      if (!m) return { error: `No merchant with id "${id}"` };
      return m;
    }
    throw new Error(`btc-map: unknown tool "${name}"`);
  }

  return {
    id: 'btc-map',
    listTools: () => [find, info],
    has: (name) => name === FIND || name === INFO,
    execute,
  };
}
