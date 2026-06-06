/**
 * BTC map discovery — turn a merchant directory (e.g. BTCMap / a local dataset)
 * into `RagDocument[]` so the agent can answer "where can I spend Bitcoin for
 * coffee near me?" with on-device semantic search over places.
 *
 * Pure transform over a generic Merchant shape. Coordinates are kept in
 * metadata so the host can still pin results on a map after retrieval.
 */

import type { RagDocument } from '../rag/types.js';

export interface Merchant {
  id?: string;
  name?: string;
  category?: string; // 'cafe' | 'restaurant' | 'shop' | …
  address?: string;
  city?: string;
  lat?: number;
  lng?: number;
  /** e.g. ['onchain', 'lightning', 'rgb']. */
  acceptedAssets?: string[];
  description?: string;
}

/** One searchable doc per merchant; lat/lng preserved in metadata for mapping. */
export function merchantsToDocuments(merchants: Merchant[]): RagDocument[] {
  return merchants
    .filter((m) => m.name)
    .map((m, i) => {
      const where = [m.address, m.city].filter(Boolean).join(', ');
      const pays = m.acceptedAssets?.length
        ? `Accepts ${m.acceptedAssets.join(', ')}.`
        : 'Accepts Bitcoin.';
      const cat = m.category ? ` (${m.category})` : '';
      const desc = m.description ? ` ${m.description}` : '';
      return {
        id: m.id ?? `merchant_${m.name ?? i}`,
        text: `${m.name}${cat}${where ? ` at ${where}` : ''}. ${pays}${desc}`.trim(),
        metadata: {
          kind: 'merchant',
          name: m.name,
          category: m.category,
          city: m.city,
          lat: m.lat,
          lng: m.lng,
        },
      };
    });
}
