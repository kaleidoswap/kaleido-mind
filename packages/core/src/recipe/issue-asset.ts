/**
 * "Issue an RGB asset" recipe — the hackathon one-liner:
 *
 *   "issue 1000 TICKET tokens called Hackathon Ticket"  → rln_issue_asset 🔒
 *   "mint an NFT called Genesis Badge"                  → rln_issue_asset 🔒 (UDA)
 *   "crea 500 token CAFE chiamati Caffè Club"           → rln_issue_asset 🔒
 *
 * No intermediate steps: the plan is a single gated call, so the recipe's job
 * is the slot extraction (name / ticker / supply / schema) and a deterministic
 * readback — exactly the part a 0.6B model gets wrong. Opt-in: register via
 * `Funnel.recipes` on hosts that bind `rln_issue_asset`.
 */

import type { Recipe, RecipeContext } from './types.js';

const VERB = /\b(issue|mint|create|launch|emetti|conia|crea)\b/i;
const NOUN = /\b(tokens?|assets?|coins?|nfts?|tickets?|gettoni|badges?)\b/i;
const NOT_ISSUE = /\b(invoice|fattura|channel|canale|swap|buy|sell|send|pay|compra|vendi|invia|paga)\b/i;
const NFT = /\b(nfts?|unique|unico|unica)\b/i;
// Words that look like tickers but are part of the request, not the asset.
const STOPWORDS = new Set(['RGB', 'NFT', 'NFTS', 'NIA', 'CFA', 'UDA', 'BTC', 'LN', 'AN', 'A']);

function parseAmount(t: string): number | undefined {
  const m = t.match(/(?:^|\s)(\d[\d.,]*)\s*([km])?(?=\s|$)/i);
  if (!m) return undefined;
  let n = Number(m[1]!.replace(/,/g, ''));
  if (m[2]) n *= m[2].toLowerCase() === 'k' ? 1_000 : 1_000_000;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseName(t: string): string | undefined {
  const quoted = t.match(/["“'‘]([^"”'’]{1,40})["”'’]/)?.[1];
  if (quoted) return quoted.trim();
  const m = t.match(/\b(?:called|named|chiamat[oaie])\s+(.+?)(?=\s+(?:with|ticker|con)\b|[,.;]|$)/i);
  return m?.[1]?.trim() || undefined;
}

function parseTicker(t: string, name?: string): string | undefined {
  const explicit = t.match(/\bticker\s+([A-Za-z0-9]{1,8})\b/i)?.[1];
  if (explicit) return explicit.toUpperCase();
  // An all-caps word that isn't part of the name ("1000 TICKET tokens").
  const nameWords = new Set((name ?? '').split(/\s+/));
  for (const w of t.match(/\b[A-Z][A-Z0-9]{1,7}\b/g) ?? []) {
    if (!STOPWORDS.has(w) && !nameWords.has(w)) return w;
  }
  return undefined;
}

/** Ticker fallback from the name: "Hackathon Ticket" → "HACKATHO". */
function tickerFromName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
}

export function extractIssueAsset(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!VERB.test(t) || !NOUN.test(t) || NOT_ISSUE.test(t)) return null;
  const schema = NFT.test(t) ? 'UDA' : 'NIA';
  const name = parseName(t);
  const ticker = parseTicker(t, name) ?? (name ? tickerFromName(name) : undefined);
  const amount = schema === 'UDA' ? 1 : parseAmount(t);
  if (!ticker && !name) return null;
  return { name: name ?? ticker, ticker, amount, schema };
}

export const issueAssetRecipe: Recipe = {
  name: 'issue-asset',
  description: 'Issue a new RGB asset (token, ticket, NFT) on the RLN node — one confirmation-gated call.',
  match: (t) => VERB.test(t) && NOUN.test(t) && !NOT_ISSUE.test(t),
  triggers: ['issue', 'mint', 'create token', 'launch token', 'nft'],
  slots: [
    { name: 'name', type: 'string', description: 'Asset name, e.g. "Hackathon Ticket"', required: true },
    { name: 'ticker', type: 'string', description: 'Uppercase ticker, up to 8 chars, e.g. "TICKET"' },
    { name: 'amount', type: 'number', description: 'Total supply in whole units (1 for an NFT)', required: true },
    { name: 'schema', type: 'string', description: 'NIA for a fungible token, UDA for a unique NFT' },
  ],
  extract: extractIssueAsset,
  confident: (s) => !!(s.ticker || s.name) && Number(s.amount) > 0,
  steps: [],
  final: {
    tool: 'rln_issue_asset',
    args: (ctx: RecipeContext) => {
      const name = String(ctx.slots.name ?? ctx.slots.ticker);
      const ticker = String(ctx.slots.ticker ?? tickerFromName(name)).toUpperCase();
      const schema = ctx.slots.schema === 'UDA' ? 'UDA' : 'NIA';
      return { name, ticker, amount: schema === 'UDA' ? 1 : Number(ctx.slots.amount), schema };
    },
  },
  summary: (ctx, final) => {
    // wdk/kaleido MCP return `asset_id` flat; the raw node API nests it under `asset`.
    const r = final as { asset_id?: string; asset?: { asset_id?: string } } | undefined;
    const id = r?.asset_id ?? r?.asset?.asset_id;
    const what = ctx.slots.schema === 'UDA' ? `unique asset ${ctx.slots.ticker ?? ctx.slots.name}` : `${ctx.slots.amount} ${ctx.slots.ticker ?? ctx.slots.name}`;
    return id ? `Issued ${what}. Asset id: ${id}` : `Issued ${what}.`;
  },
};
