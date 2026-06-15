import { describe, expect, it } from 'vitest';
import {
  createBtcMapToolSource,
  type BtcMapFetch,
  type LocationProvider,
  type BtcMapMerchant,
} from './btc-map.js';

const exec = async (
  src: ReturnType<typeof createBtcMapToolSource>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> => src.execute(name, args);

describe('createBtcMapToolSource — tool surface', () => {
  it('exposes ONLY find_merchant_locations (no get_merchant_info, no legacy name)', () => {
    const src = createBtcMapToolSource();
    const names = src.listTools().map((t) => t.name);
    expect(names).toEqual(['find_merchant_locations']);
    expect(src.has('find_merchant_locations')).toBe(true);
    expect(src.has('get_merchant_info')).toBe(false);
    expect(src.has('find_merchants')).toBe(false);
  });

  it('throws on unknown tool', async () => {
    const src = createBtcMapToolSource();
    await expect(exec(src, 'no_such_tool')).rejects.toThrow(/unknown tool/);
  });
});

describe('find_merchant_locations — no offline fallback', () => {
  it('returns a clean error when no fetch adapter is injected', async () => {
    const src = createBtcMapToolSource();
    const r = await exec(src, 'find_merchant_locations', {});
    expect(r.success).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(r.error).toMatch(/fetch adapter|unavailable/i);
    expect(r.merchants).toBeUndefined();
  });

  it('returns a clean error when location cannot be resolved', async () => {
    // Fetch is wired, but the location provider has no GPS and no geocoder.
    const noLocation: LocationProvider = { getCurrent: async () => null };
    const src = createBtcMapToolSource({
      location: noLocation,
      fetch: async () => [],
    });
    const r = await exec(src, 'find_merchant_locations', {});
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/location/i);
  });

  it('surfaces a fetch failure as a clean error (no fake fallback)', async () => {
    const src = createBtcMapToolSource({
      location: { getCurrent: async () => ({ lat: 46.0, lng: 8.95, precise: true }) },
      fetch: async () => { throw new Error('btcmap is down'); },
    });
    const r = await exec(src, 'find_merchant_locations', {});
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/btcmap is down/);
    expect(r.merchants).toBeUndefined();
  });

  it('errors with the bad address when geocoding fails (no near_me fallback)', async () => {
    const location: LocationProvider = {
      getCurrent: async () => null,
      geocode: async () => null,
    };
    const src = createBtcMapToolSource({ location, fetch: async () => [] });
    const r = await exec(src, 'find_merchant_locations', { near_address: 'Nowhereistan' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Nowhereistan/);
  });
});

describe('find_merchant_locations — live path', () => {
  const point = { lat: 46.0, lng: 8.95 };
  const locationOnly: LocationProvider = {
    getCurrent: async () => ({ ...point, label: 'Lugano', precise: true }),
  };

  it('uses live fetch when location resolves', async () => {
    const captured: any[] = [];
    const fetchImpl: BtcMapFetch = async (q) => {
      captured.push(q);
      return [
        { id: 1, name: 'Live Café', category: 'cafe', lat: 46.0, lng: 8.95, distance_m: 42,
          acceptedAssets: ['lightning'] } satisfies BtcMapMerchant,
      ];
    };
    const src = createBtcMapToolSource({ location: locationOnly, fetch: fetchImpl });
    const r = await exec(src, 'find_merchant_locations', { query: 'café', radius_km: 3 });
    expect(r.success).toBe(true);
    expect(r.source).toBe('btcmap');
    expect(r.precise_location).toBe(true);
    expect(r.merchants[0].name).toBe('Live Café');
    expect(r.merchants[0].distance_m).toBe(42);
    expect(captured[0]).toMatchObject({
      center: { lat: 46.0, lng: 8.95 },
      radiusMeters: 3000,
      query: 'café',
      limit: 10,
    });
  });

  it('geocodes near_address when provided', async () => {
    const geocoded = { lat: 38.71, lng: -9.143 };
    const seen: string[] = [];
    const location: LocationProvider = {
      getCurrent: async () => ({ lat: 46.0, lng: 8.95, precise: true }), // should NOT be used
      geocode: async (addr) => {
        seen.push(addr);
        return geocoded;
      },
    };
    const fetchImpl: BtcMapFetch = async (q) => [
      { id: 'lis', name: 'Lisbon Place', lat: q.center.lat, lng: q.center.lng,
        acceptedAssets: ['lightning'] } satisfies BtcMapMerchant,
    ];
    const src = createBtcMapToolSource({ location, fetch: fetchImpl });
    const r = await exec(src, 'find_merchant_locations', { near_address: 'Lisbon' });
    expect(r.success).toBe(true);
    expect(seen).toEqual(['Lisbon']);
    expect(r.merchants[0].lat).toBeCloseTo(geocoded.lat);
    expect(r.merchants[0].lng).toBeCloseTo(geocoded.lng);
    expect(r.precise_location).toBe(false); // came from geocode, not GPS
  });

  it('clamps limit to 1–20 with a default of 10', async () => {
    const fetchImpl: BtcMapFetch = async (q) =>
      Array.from({ length: q.limit }, (_, i) => ({
        id: i, name: `m${i}`, lat: 0, lng: 0, acceptedAssets: ['lightning'],
      })) as BtcMapMerchant[];
    const src = createBtcMapToolSource({ location: locationOnly, fetch: fetchImpl });

    const dflt = await exec(src, 'find_merchant_locations', {});
    expect(dflt.merchants.length).toBe(10);

    const big = await exec(src, 'find_merchant_locations', { limit: 9999 });
    expect(big.merchants.length).toBe(20); // clamped to 20

    const tiny = await exec(src, 'find_merchant_locations', { limit: -5 });
    expect(tiny.merchants.length).toBe(1); // clamped to 1
  });
});
