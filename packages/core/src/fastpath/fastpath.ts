/**
 * Tier-0 deterministic fast-path — answer the common, unambiguous wallet asks
 * with NO LLM at all. "balance", "receive address", "btc price" map straight to
 * a single tool call. The model is reserved for genuine ambiguity.
 *
 * This is the biggest mobile UX lever: ~60-80% of wallet requests are simple,
 * and our eval showed tiny models are slow + weak at args — so skip them here.
 *
 * Matchers are intentionally CONSERVATIVE: when in doubt, return null and let
 * the recipe / agentic loop handle it. Under-firing is fine; mis-firing is not.
 *
 * Pure data — no deps. The host executes the returned tool + renders the result.
 */

export interface FastIntent {
  name: string;
  /** Contract tool to call when this intent matches. */
  tool: string;
  /** Equivalent tools to try, in order, when the host doesn't expose `tool`. */
  fallbackTools?: string[];
  /** True only when this intent UNAMBIGUOUSLY matches the text. */
  match: (text: string) => boolean;
  /** Optional args derived from the text (default: none). */
  args?: (text: string) => Record<string, unknown>;
  /**
   * Extra reads added to the answer when `when(text)` holds, e.g. the RGB
   * asset list for "my BTC and USDT balance". The first tool the host has is
   * called; its result reaches the renderer under `name`.
   */
  also?: Array<{ name: string; tools: string[]; when: (text: string) => boolean }>;
}

export interface FastHit {
  intent: FastIntent;
  /** The intent's primary tool. */
  tool: string;
  /** Primary tool first, then the fallbacks. */
  tools: string[];
  args: Record<string, unknown>;
}

export class FastPath {
  private intents: FastIntent[];
  constructor(intents: FastIntent[] = []) {
    this.intents = [...intents];
  }
  add(intent: FastIntent): void {
    this.intents.push(intent);
  }
  list(): FastIntent[] {
    return [...this.intents];
  }
  /** The first unambiguously-matching intent, or null. */
  select(text: string): FastHit | null {
    const intent = this.intents.find((i) => i.match(text));
    return intent
      ? { intent, tool: intent.tool, tools: [intent.tool, ...(intent.fallbackTools ?? [])], args: intent.args?.(text) ?? {} }
      : null;
  }
}

// A "spend or compound" guard — never fast-path anything that moves money or
// chains another action ("send", "pay", "and then", "swap").
const ACTIONY = /\b(send|pay|transfer|swap|buy|sell|then|after that)\b/i;
// A balance question that names an RGB asset also wants the asset balances.
const NAMES_ASSET = /\b(usdt|xaut|rgb|assets?|tokens?)\b/i;
// Asks that create something are not reads, even when they mention assets.
const CREATEY = /\b(issue|mint|create|make|new|generate|invoice|receive|request)\b/i;

/** Default wallet read intents (balance / RGB assets / receive address / price). */
export const WALLET_FAST_INTENTS: FastIntent[] = [
  {
    name: 'balance',
    tool: 'get_balances',
    fallbackTools: ['rln_get_balances', 'wdk_get_balances'],
    also: [{ name: 'assets', tools: ['rln_list_assets', 'wdk_list_assets'], when: (t) => NAMES_ASSET.test(t) }],
    match: (t) => !ACTIONY.test(t) && /\b(balance|funds|how much (do i|have i|i have)|how much.* (do i have|in my wallet))\b/i.test(t),
  },
  {
    name: 'assets',
    tool: 'rln_list_assets',
    fallbackTools: ['wdk_list_assets'],
    match: (t) =>
      !ACTIONY.test(t) &&
      !CREATEY.test(t) &&
      /\b(which|what|list|show|my)\b[^.?!]*\b(rgb assets?|assets?|tokens?)\b|\b(rgb assets?|tokens?) (do i|i) (have|hold|own)\b/i.test(t),
  },
  {
    name: 'address',
    tool: 'spark_get_address',
    fallbackTools: ['rln_get_address', 'wdk_get_address'],
    match: (t) => !ACTIONY.test(t) && /\b(receive address|deposit address|my address|an address|get .*address|where.* receive)\b/i.test(t),
  },
  {
    name: 'price',
    tool: 'get_price',
    match: (t) => !ACTIONY.test(t) && /\b(btc price|bitcoin price|price of (btc|bitcoin)|how much is (a |one )?(btc|bitcoin))\b/i.test(t),
  },
];
