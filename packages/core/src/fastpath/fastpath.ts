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
  /** True only when this intent UNAMBIGUOUSLY matches the text. */
  match: (text: string) => boolean;
  /** Optional args derived from the text (default: none). */
  args?: (text: string) => Record<string, unknown>;
}

export interface FastHit {
  intent: FastIntent;
  tool: string;
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
    return intent ? { intent, tool: intent.tool, args: intent.args?.(text) ?? {} } : null;
  }
}

// A "spend or compound" guard — never fast-path anything that moves money or
// chains another action ("send", "pay", "and then", "swap").
const ACTIONY = /\b(send|pay|transfer|swap|buy|sell|then|after that)\b/i;

/** Default wallet read intents (balance / receive address / price). */
export const WALLET_FAST_INTENTS: FastIntent[] = [
  {
    name: 'balance',
    tool: 'get_balances',
    match: (t) => !ACTIONY.test(t) && /\b(balance|funds|how much (do i|have i|i have)|how much.* (do i have|in my wallet))\b/i.test(t),
  },
  {
    name: 'address',
    tool: 'spark_get_address',
    match: (t) => !ACTIONY.test(t) && /\b(receive address|deposit address|my address|an address|get .*address|where.* receive)\b/i.test(t),
  },
  {
    name: 'price',
    tool: 'get_price',
    match: (t) => !ACTIONY.test(t) && /\b(btc price|bitcoin price|price of (btc|bitcoin)|how much is (a |one )?(btc|bitcoin))\b/i.test(t),
  },
];
