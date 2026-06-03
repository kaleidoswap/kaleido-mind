/**
 * L402 tool source — lets the agent pay for paywalled HTTP resources in sats.
 *
 * Exposes one tool, `fetch_paid_resource(url)`, that runs the L402 flow:
 *   GET url → 402 with an L402 challenge (macaroon + Lightning invoice)
 *   → pay the invoice (via the injected `payInvoice`, e.g. the on-device wallet)
 *   → re-GET with `Authorization: L402 <macaroon>:<preimage>` → return the body.
 *
 * This is the "agent pays for a tool in sats" capability: any KaleidoMind agent
 * (mobile or desktop) can buy premium data / inference autonomously. Payment
 * runs through the host's wallet, so it stays on-device; the engine's
 * confirmation gate can wrap the spend if desired.
 *
 * No dependencies — uses global fetch (Node ≥18, React Native). The fetch impl
 * is injectable for testing.
 */

import type { ToolDef } from '../types.js';
import type { ToolSource } from './source.js';

export interface L402PayResult {
  /** Payment preimage (hex) — proves the invoice was paid. */
  preimage: string;
}

export interface L402Options {
  /** Pay a BOLT11 invoice, resolve with the preimage. Wallet on device; mock in tests. */
  payInvoice: (invoice: string, amountSats: number) => Promise<L402PayResult>;
  /** Override fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Optional progress logging. */
  log?: (msg: string) => void;
  /**
   * Gate the tool behind the engine's confirmation (default true). The catch:
   * the invoice amount is only known DURING execution (the 402 challenge), so a
   * pre-execution confirmation can't show it. On hosts without a dedicated L402
   * confirmation UX, set this false and bound spending with `maxAutoPaySats`.
   */
  requiresConfirmation?: boolean;
  /** Auto-pay only invoices up to this many sats; reject larger ones. */
  maxAutoPaySats?: number;
}

/** Parse an L402 (or legacy LSAT) WWW-Authenticate challenge. */
export function parseL402Challenge(header: string): { macaroon: string; invoice: string } | null {
  const macaroon = header.match(/macaroon="([^"]+)"/i)?.[1];
  const invoice = header.match(/invoice="([^"]+)"/i)?.[1];
  return macaroon && invoice ? { macaroon, invoice } : null;
}

/** Rough BOLT11 amount → sats (for logging / spend caps). 0 if unparseable. */
export function bolt11AmountSats(invoice: string): number {
  const m = invoice.match(/^ln(?:bc|tb|bcrt)(\d+)([munp]?)/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const mult = (m[2] || '').toLowerCase();
  const btc = mult === 'm' ? n / 1e3 : mult === 'u' ? n / 1e6 : mult === 'n' ? n / 1e9 : mult === 'p' ? n / 1e12 : n;
  return Math.round(btc * 1e8);
}

export function createL402ToolSource(opts: L402Options): ToolSource {
  const doFetch = opts.fetchImpl ?? fetch;

  const tool: ToolDef = {
    name: 'fetch_paid_resource',
    description:
      'Fetch a paywalled (L402) HTTP resource, automatically paying the required ' +
      'Lightning invoice in sats. Use this for premium or paid APIs (market data, ' +
      'inference, etc.). Pass the resource URL.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The resource URL to fetch' } },
      required: ['url'],
    },
    requiresConfirmation: opts.requiresConfirmation ?? true,
  };

  async function execute(_name: string, args: Record<string, unknown>): Promise<unknown> {
    const url = String(args.url ?? '');
    if (!url) throw new Error('fetch_paid_resource: url is required');

    let res = await doFetch(url);

    if (res.status === 402) {
      const challenge = parseL402Challenge(res.headers.get('www-authenticate') ?? '');
      if (!challenge) throw new Error('402 Payment Required but no L402 challenge present');

      const amountSats =
        bolt11AmountSats(challenge.invoice) || Number(res.headers.get('x-amount-sats') ?? 0);

      if (opts.maxAutoPaySats != null && amountSats > opts.maxAutoPaySats) {
        throw new Error(
          `L402 invoice is ${amountSats} sats, above the ${opts.maxAutoPaySats} sat auto-pay cap — declined`,
        );
      }

      opts.log?.(`L402: ${url} requires ${amountSats} sats — paying…`);

      const { preimage } = await opts.payInvoice(challenge.invoice, amountSats);

      res = await doFetch(url, {
        headers: { Authorization: `L402 ${challenge.macaroon}:${preimage}` },
      });
      opts.log?.(`L402: paid ${amountSats} sats → ${res.status}`);
    }

    if (!res.ok) throw new Error(`fetch_paid_resource: ${res.status} ${res.statusText}`);
    const body = await res.text();
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  return {
    id: 'l402',
    listTools: () => [tool],
    has: (name) => name === tool.name,
    execute,
  };
}
