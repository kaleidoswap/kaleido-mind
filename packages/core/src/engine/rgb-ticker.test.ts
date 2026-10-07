import { describe, it, expect, vi } from 'vitest';
import { resolveRgbTicker } from './rgb-ticker.js';

const assets = [
  { asset_id: 'rgb:usdt-1', ticker: 'USDT', name: 'Tether USD' },
  { asset_id: 'rgb:xaut-1', ticker: 'XAUT', name: 'Tether Gold' },
];
const host = (result: unknown, tools = ['rln_list_assets']) => ({
  hasTool: async (n: string) => tools.includes(n),
  run: vi.fn(async () => result),
});

describe('resolveRgbTicker', () => {
  it('replaces a ticker with the asset id from the same host', async () => {
    const h = host(JSON.stringify(assets));
    expect(await resolveRgbTicker('rln_send_asset', { asset_id: 'usdt', amount: 1 }, h)).toEqual({ asset_id: 'rgb:usdt-1', amount: 1 });
    expect(h.run).toHaveBeenCalledWith('rln_list_assets', {});
    expect(await resolveRgbTicker('rln_create_rgb_invoice', { asset: 'XAUT' }, host({ assets }))).toEqual({ asset: 'rgb:xaut-1' });
    expect(await resolveRgbTicker('wdk_send_asset', { asset_id: 'USDT' }, host({ nia: assets }, ['wdk_list_assets']))).toEqual({ asset_id: 'rgb:usdt-1' });
  });

  it('leaves ids, unknown tickers, other tools and hosts without a list tool alone', async () => {
    const h = host(assets);
    expect(await resolveRgbTicker('rln_send_asset', { asset_id: 'rgb:usdt-1' }, h)).toEqual({ asset_id: 'rgb:usdt-1' });
    expect(await resolveRgbTicker('rln_send_asset', { asset_id: 'FOO' }, h)).toEqual({ asset_id: 'FOO' });
    expect(await resolveRgbTicker('rln_issue_asset', { ticker: 'USDT' }, h)).toEqual({ ticker: 'USDT' });
    expect(await resolveRgbTicker('rln_send_asset', { asset_id: 'USDT' }, host(assets, []))).toEqual({ asset_id: 'USDT' });
  });
});
