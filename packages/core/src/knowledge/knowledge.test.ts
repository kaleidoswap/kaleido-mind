/** Knowledge pack + corpus adapter tests — pure transforms. */

import { describe, it, expect } from 'vitest';
import { BITCOIN_COPILOT_DOCS } from './bitcoin-copilot.js';
import { walletHistoryToDocuments, contactsToDocuments } from './wallet.js';
import { merchantsToDocuments } from './merchants.js';

describe('BITCOIN_COPILOT_DOCS', () => {
  it('is a non-trivial corpus with unique ids and real text', () => {
    expect(BITCOIN_COPILOT_DOCS.length).toBeGreaterThanOrEqual(15);
    const ids = BITCOIN_COPILOT_DOCS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
    expect(BITCOIN_COPILOT_DOCS.every((d) => (d.text?.length ?? 0) > 40)).toBe(true);
    // covers the key concept the hero demo asks about
    expect(BITCOIN_COPILOT_DOCS.some((d) => /inbound liquidity/i.test(d.text))).toBe(true);
  });
});

describe('walletHistoryToDocuments', () => {
  it('renders sent/received sentences with date, amount, counterparty', () => {
    const docs = walletHistoryToDocuments([
      { id: 't1', type: 'send', amountSats: 5000, counterparty: 'Bob', memo: 'lunch', timestamp: 1700000000000 },
      { id: 't2', type: 'receive', amountSats: 21000, counterparty: 'Alice', timestamp: 1700100000000 },
      { type: 'swap', amountSats: 100000, asset: 'USDT' },
    ]);
    expect(docs[0].text).toMatch(/you sent 5000 sats to Bob — "lunch"/);
    expect(docs[1].text).toMatch(/you received 21000 sats from Alice/);
    expect(docs[2].text).toMatch(/you swapped 100000 USDT/);
    expect(docs[2].id).toBe('tx_2'); // id defaulted
    expect(docs[0].metadata?.kind).toBe('transaction');
  });
});

describe('contactsToDocuments', () => {
  it('includes address/nostr/note and skips empty contacts', () => {
    const docs = contactsToDocuments([
      { name: 'Bob', lightningAddress: 'bob@getalby.com', note: 'coffee buddy' },
      {}, // skipped
    ]);
    expect(docs).toHaveLength(1);
    expect(docs[0].text).toMatch(/Contact: Bob — Lightning address bob@getalby.com, coffee buddy/);
  });
});

describe('merchantsToDocuments', () => {
  it('renders place + acceptance and preserves coordinates in metadata', () => {
    const docs = merchantsToDocuments([
      {
        name: 'Bitcoin Café',
        category: 'cafe',
        address: 'Via Nassa 1',
        city: 'Lugano',
        lat: 46.0,
        lng: 8.95,
        acceptedAssets: ['lightning', 'onchain'],
      },
      { city: 'nowhere' }, // no name → skipped
    ]);
    expect(docs).toHaveLength(1);
    expect(docs[0].text).toMatch(/Bitcoin Café \(cafe\) at Via Nassa 1, Lugano\. Accepts lightning, onchain\./);
    expect(docs[0].metadata).toMatchObject({ kind: 'merchant', lat: 46.0, lng: 8.95, city: 'Lugano' });
  });
});
