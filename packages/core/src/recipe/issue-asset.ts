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

// The request must OPEN with the verb ("issue …", "please mint …", "puoi creare …"),
// so "I have an issue with my tokens" or "how do I create a token?" stay with the model.
const VERB = /^(?:(?:please|pls|per favore|can you|could you|puoi|potresti)\s+)?(issue|mint|create|launch|emetti|conia|crea|creare|emettere|coniare)\b/i;
const NOUN = /\b(tokens?|assets?|coins?|nfts?|tickets?|gettoni|badges?)\b/i;
const NOT_ISSUE = /\b(invoice|fattura|channel|canale|swap|buy|sell|send|pay|compra|vendi|invia|paga)\b/i;
const NFT = /\b(nfts?|unique|unico|unica)\b/i;
// Words that look like tickers but are part of the request, not the asset.
const STOPWORDS = new Set(['RGB', 'NFT', 'NFTS', 'NIA', 'CFA', 'UDA', 'BTC', 'LN', 'AN', 'A']);

// "1000", "1,000", "1.000" (it), "1.5", "1,5" (it), optionally followed by k/m.
const NUM = String.raw`(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*([km])?`;

function toNumber(digits: string, suffix?: string): number | undefined {
  // Groups of exactly three digits are thousands separators in both "1,000" and "1.000";
  // a single separator followed by another digit count is a decimal point.
  const n = /^\d{1,3}(?:[.,]\d{3})+$/.test(digits)
    ? Number(digits.replace(/[.,]/g, ''))
    : Number(digits.replace(',', '.'));
  const scaled = suffix ? n * (suffix.toLowerCase() === 'k' ? 1_000 : 1_000_000) : n;
  return Number.isFinite(scaled) && scaled > 0 ? scaled : undefined;
}

/**
 * The supply: an explicit "supply 300" / "1m supply" wins, then a number right before the token
 * noun / ticker ("1000 TICKET tokens", "500 token"). Numbers inside the asset name
 * ("Web3 Summit 2026") are never the supply.
 */
function parseAmount(t: string, name?: string): number | undefined {
  const rest = name ? t.replace(name, ' ') : t;
  const labelled = rest.match(new RegExp(String.raw`\b(?:supply|amount|quantit[àa]|totale)\s*(?:of|di|[:=])?\s*` + NUM, 'i'));
  if (labelled) return toNumber(labelled[1]!, labelled[2]);
  const trailing = rest.match(new RegExp(String.raw`(?:^|\s)` + NUM + String.raw`\s+(?:supply|di supply)\b`, 'i'));
  if (trailing) return toNumber(trailing[1]!, trailing[2]);
  const beforeNoun = rest.match(new RegExp(String.raw`(?:^|\s)` + NUM + String.raw`\s+(?:[A-Z][A-Z0-9]{1,7}\s+)?(?:tokens?|coins?|tickets?|gettoni|badges?|assets?)\b`, 'i'));
  if (beforeNoun) return toNumber(beforeNoun[1]!, beforeNoun[2]);
  return undefined;
}

const unquote = (s: string) => s.replace(/^["“'‘]+|["”'’]+$/g, '').trim();

function parseName(t: string): string | undefined {
  // "called Joe's Pizza with ticker 'JOE'" → Joe's Pizza (apostrophes inside a name are fine).
  const m = t.match(/\b(?:called|named|chiamat[oaie])\s+(.+?)(?=\s+(?:with|ticker|con|supply)\b|[,;]|\.(?:\s|$)|$)/i);
  if (m?.[1]) return unquote(m[1]) || undefined;
  // Otherwise only a properly paired quote: double quotes, or single quotes that open
  // after a space and close before a space/punctuation (so "Joe's" never opens one).
  const quoted = t.match(/["“]([^"”]{1,40})["”]/)?.[1] ?? t.match(/(?:^|\s)['‘]([^'’]{1,40})['’](?=\s|$|[,.;!?])/)?.[1];
  return quoted?.trim() || undefined;
}

function parseTicker(t: string, name?: string): string | undefined {
  const explicit = t.match(/\bticker\s*[:=]?\s*["'“‘]?([A-Za-z0-9]{1,8})\b/i)?.[1];
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
  const amount = schema === 'UDA' ? 1 : parseAmount(t, name);
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
