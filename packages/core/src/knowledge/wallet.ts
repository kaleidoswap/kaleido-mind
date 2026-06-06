/**
 * Personal wallet knowledge — turn a user's transaction history + contacts into
 * `RagDocument[]` so the agent can answer "what did I spend on coffee last
 * month?", "who did I pay 50k sats to?", "summarise my swaps" — all on-device,
 * nothing leaving the phone.
 *
 * Pure transforms over minimal, generic shapes (hosts map their own types in).
 * No deps, no PII leaves: the host decides what to ingest.
 */

import type { RagDocument } from '../rag/types.js';

export interface WalletTx {
  id?: string;
  /** 'send' | 'receive' | 'swap' | 'deposit' | 'withdraw' | … */
  type?: string;
  amountSats?: number;
  asset?: string; // 'BTC' | 'USDT' | 'XAUT' | …
  /** Who/where — a name, contact, address, or merchant. */
  counterparty?: string;
  memo?: string;
  status?: string;
  /** Epoch ms. */
  timestamp?: number;
}

export interface Contact {
  name?: string;
  lightningAddress?: string;
  npub?: string;
  note?: string;
}

function isoDate(ts?: number): string {
  if (!ts) return 'an unknown date';
  // Avoid Date formatting differences — just YYYY-MM-DD from the ISO string.
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return 'an unknown date';
  }
}

/** One short, searchable sentence per transaction. */
export function walletHistoryToDocuments(txs: WalletTx[]): RagDocument[] {
  return txs.map((tx, i) => {
    const date = isoDate(tx.timestamp);
    const asset = tx.asset ?? 'sats';
    const amount = tx.amountSats != null ? `${tx.amountSats} ${asset === 'BTC' ? 'sats' : asset}` : 'an amount';
    const verb =
      tx.type === 'receive' || tx.type === 'deposit'
        ? 'received'
        : tx.type === 'swap'
          ? 'swapped'
          : tx.type === 'withdraw'
            ? 'withdrew'
            : 'sent';
    const who = tx.counterparty ? ` ${verb === 'received' ? 'from' : 'to'} ${tx.counterparty}` : '';
    const memo = tx.memo ? ` — "${tx.memo}"` : '';
    const status = tx.status && tx.status !== 'complete' ? ` (${tx.status})` : '';
    return {
      id: tx.id ?? `tx_${i}`,
      text: `On ${date} you ${verb} ${amount}${who}${memo}${status}.`,
      metadata: { kind: 'transaction', type: tx.type, asset: tx.asset, timestamp: tx.timestamp },
    };
  });
}

/** One doc per contact, so "who is Bob?" / "pay my friend" can resolve. */
export function contactsToDocuments(contacts: Contact[]): RagDocument[] {
  return contacts
    .filter((c) => c.name || c.lightningAddress || c.npub)
    .map((c, i) => {
      const parts: string[] = [];
      if (c.lightningAddress) parts.push(`Lightning address ${c.lightningAddress}`);
      if (c.npub) parts.push(`Nostr ${c.npub}`);
      if (c.note) parts.push(c.note);
      return {
        id: `contact_${c.name ?? c.lightningAddress ?? i}`,
        text: `Contact: ${c.name ?? 'unnamed'}${parts.length ? ` — ${parts.join(', ')}` : ''}.`,
        metadata: { kind: 'contact', name: c.name },
      };
    });
}
