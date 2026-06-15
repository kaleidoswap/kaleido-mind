import { describe, it, expect } from 'vitest';
import {
  allowListFirewall,
  denyListFirewall,
  firewallFromKeyList,
  buildDelegateConfig,
} from './delegate.js';

describe('allowListFirewall', () => {
  it('builds an allow-list, trimming + de-duping keys', () => {
    expect(allowListFirewall([' k1 ', 'k2', 'k1', ''])).toEqual({
      mode: 'allow',
      publicKeys: ['k1', 'k2'],
    });
  });

  it('is empty for no keys (caller must decide: open vs refuse)', () => {
    expect(allowListFirewall([])).toEqual({ mode: 'allow', publicKeys: [] });
  });
});

describe('denyListFirewall', () => {
  it('builds a deny-list', () => {
    expect(denyListFirewall(['bad'])).toEqual({ mode: 'deny', publicKeys: ['bad'] });
  });
});

describe('firewallFromKeyList', () => {
  it('parses comma/space/newline-separated keys into an allow-list', () => {
    expect(firewallFromKeyList('k1, k2\nk3 k4')).toEqual({
      mode: 'allow',
      publicKeys: ['k1', 'k2', 'k3', 'k4'],
    });
  });

  it('returns undefined for empty/missing input (advertise openly)', () => {
    expect(firewallFromKeyList('')).toBeUndefined();
    expect(firewallFromKeyList('   ')).toBeUndefined();
    expect(firewallFromKeyList(null)).toBeUndefined();
    expect(firewallFromKeyList(undefined)).toBeUndefined();
  });
});

describe('buildDelegateConfig', () => {
  it('defaults fallbackToLocal to false and trims the key', () => {
    expect(buildDelegateConfig('  pk  ')).toEqual({
      providerPublicKey: 'pk',
      fallbackToLocal: false,
    });
  });

  it('passes through fallbackToLocal, timeout, forceNewConnection when set', () => {
    expect(
      buildDelegateConfig('pk', { fallbackToLocal: true, timeout: 60000, forceNewConnection: true }),
    ).toEqual({
      providerPublicKey: 'pk',
      fallbackToLocal: true,
      timeout: 60000,
      forceNewConnection: true,
    });
  });

  it('omits optional fields that are not set', () => {
    const cfg = buildDelegateConfig('pk', { fallbackToLocal: false });
    expect('timeout' in cfg).toBe(false);
    expect('forceNewConnection' in cfg).toBe(false);
  });
});
