import { describe, expect, it } from 'vitest';
import {
  createBtcMapToolSource,
  BTC_MAP_SAMPLE,
  type BtcMapFetch,
  type LocationProvider,
  type BtcMapMerchant,
} from './btc-map.js';
import type { Merchant } from './merchants.js';

const exec = async (
  src: ReturnType<typeof createBtcMapToolSource>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> => src.execute(name, args);

describe('createBtcMapToolSource — tool surface', () => {
  it('exposes find_merchant_locations and get_merchant_info', () => {
    const src = createBtcMapToolSource();
    const names = src.listTools().map((t) => t.name);
    expect(names).toEqual(['find_merchant_locations', 'get_merchant_info']);
    expect(src.has('find_merchant_locations')).toBe(true);
    expect(src.has('get_merchant_info')).toBe(true);
    expect(src.has('find_merchants')).toBe(false); // legacy name is gone
  });

  it('throws on unknown tool', async () => {
    const src = createBtcMapToolSource();
    await expect(exec(src, 'no_such_tool')).rejects.toThrow(/unknown tool/);
  });
});

describe('find_merchant_locations — offline fallback', () => {
  it('returns offline rows when no location and no fetch are injected', async () => {
    const src = createBtcMapToolSource();
    const r = await exec(src, 'find_merchant_locations', {});
    expect(r.success).toBe(true);
    expect(r.source).toBe('offline');
    expect(r.precise_location).toBe(false);
    expect(r.merchants.length).toBeGreaterThan(0);
    expect(r.merchants.length).toBeLessThanOrEqual(10); // default limit
  });

  it('honours category filter on offline data', async () => {
    const src = createBtcMapToolSource();
    const r = await exec(src, 'find_merchant_locations', { category: 'bar' });
    expect(r.merchants.every((m: any) => m.category === 'bar')).toBe(true);
    // Sample has at least one bar (PubKey).
    expect(r.merchants.length).toBeGreaterThan(0);
  });

  it('honours query filter on offline data', async () => {
    const src = createBtcMapToolSource();
    const r = await exec(src, 'find_merchant_locations', { query: 'PubKey' });
    expect(r.merchants.some((m: any) => m.name === 'PubKey')).toBe(true);
  });

  it('clamps limit to 1–20 with a default of 10', async () => {
    const src = createBtcMapToolSource();
    const big = await exec(src, 'find_merchant_locations', { limit: 9999 });
    expect(big.merchants.length).toBeLessThanOrEqual(20);
    const tiny = await exec(src, 'find_merchant_locations', { limit: -5 });
    expect(tiny.merchants.length).toBeGreaterThanOrEqual(1); // clamped to ≥1
  });

  it('caller can override the offline dataset', async () => {
    const custom: Merchant[] = [
      { id: 'only', name: 'Only Café', category: 'cafe', acceptedAssets: ['lightning'] },
    ];
    const src = createBtcMapToolSource({ offlineMerchants: custom });
    const r = await exec(src, 'find_merchant_locations', {});
    expect(r.merchants).toHaveLength(1);
    expect(r.merchants[0].name).toBe('Only Café');
  });
});

describe('find_merchant_locations — live path (host-injected fetch)', () => {
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
    expect(seen).toEqual(['Lisbon']);
    expect(r.merchants[0].lat).toBeCloseTo(geocoded.lat);
    expect(r.merchants[0].lng).toBeCloseTo(geocoded.lng);
    expect(r.precise_location).toBe(false); // came from geocode, not GPS
  });

  it('falls back to offline when live fetch throws', async () => {
    const src = createBtcMapToolSource({
      location: locationOnly,
      fetch: async () => { throw new Error('btcmap is down'); },
    });
    const r = await exec(src, 'find_merchant_locations', {});
    expect(r.source).toBe('offline');
    expect(r.merchants.length).toBeGreaterThan(0);
  });

  it('falls back to offline when location resolves but fetch is missing', async () => {
    const src = createBtcMapToolSource({ location: locationOnly });
    const r = await exec(src, 'find_merchant_locations', {});
    expect(r.source).toBe('offline'); // no fetch injected → no live path
  });
});

describe('get_merchant_info', () => {
  it('finds a merchant by id', async () => {
    const src = createBtcMapToolSource();
    const r = await exec(src, 'get_merchant_info', { merchant_id: 'nyc-pubkey' });
    expect(r.success).toBe(true);
    expect(r.merchant.name).toBe('PubKey');
    expect(r.merchant.accepts_lightning).toBe(true);
  });

  it('finds a merchant by exact name', async () => {
    const src = createBtcMapToolSource();
    const r = await exec(src, 'get_merchant_info', { merchant_name: 'Bistro Libertine' });
    expect(r.success).toBe(true);
    expect(r.merchant.city).toBe('Lugano');
  });

  it('returns an error and possible suggestions when the name does not match', async () => {
    const src = createBtcMapToolSource();
    const r = await exec(src, 'get_merchant_info', { merchant_name: 'Nonexistent Merchant Name' });
    expect(r.success).toBe(false);
    expect(typeof r.error).toBe('string');
  });

  it('treats a fuzzy-close name as a hit (not an error)', async () => {
    const src = createBtcMapToolSource();
    const r = await exec(src, 'get_merchant_info', { merchant_name: 'Pubkey' }); // PubKey
    expect(r.success).toBe(true);
    expect(r.merchant.name).toBe('PubKey');
  });

  it('returns an error (no throw) when given nothing', async () => {
    const src = createBtcMapToolSource();
    const r = await exec(src, 'get_merchant_info', {});
    expect(r.success).toBe(false);
  });
});

describe('BTC_MAP_SAMPLE', () => {
  it('has a row in Lugano with Lightning support (sanity)', () => {
    const lugano = BTC_MAP_SAMPLE.filter((m) => m.city === 'Lugano');
    expect(lugano.length).toBeGreaterThan(0);
    expect(lugano.every((m) => m.acceptedAssets?.includes('lightning'))).toBe(true);
  });
});
