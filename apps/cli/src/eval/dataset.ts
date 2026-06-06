/**
 * Seeded synthetic dataset of "classic" wallet/Bitcoin requests, with ground
 * truth (skill, tool, CLI command, args). Deterministic from a seed, so the
 * exact same cases run on every model/host — reproducible evidence.
 */

export type Category = 'wallet' | 'trading' | 'commerce' | 'knowledge' | 'memory' | 'negative';

export interface EvalCase {
  id: string;
  intent: string;
  category: Category;
  prompt: string;
  /** Expected skill (skill mechanisms). */
  expectSkill?: string;
  /** Expected tool for structured mechanisms; null = must NOT call a tool. */
  expectTool?: string | null;
  /** For the CLI mechanism: the run_command argument should match this. */
  expectCli?: string;
  /** Optional arg substrings that must appear in the chosen tool's arguments. */
  expectArgs?: string[];
}

interface Intent {
  id: string;
  category: Category;
  expectSkill?: string;
  expectTool?: string | null;
  expectCli?: string;
  templates: string[];
  /** Returns prompt-fill values + expected arg substrings, given the rng. */
  fill?: (rng: () => number) => { vars: Record<string, string>; args?: string[] };
}

// Deterministic PRNG (mulberry32).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: () => number, arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;

const CONTACTS = ['Bob', 'Alice', 'Satoshi', 'mom'];
const AMOUNTS = [5000, 10000, 21000, 50000];
const PAIRS = ['BTC/USDT', 'BTC/XAUT'];

const INTENTS: Intent[] = [
  {
    id: 'balance', category: 'wallet', expectSkill: 'kaleido-wallet', expectTool: 'wdk_get_balances', expectCli: 'kaleido wallet balance',
    templates: ["what's my balance?", 'how much bitcoin do I have?', 'show my wallet balance', 'how many sats are in my wallet?'],
  },
  {
    id: 'receive', category: 'wallet', expectSkill: 'kaleido-wallet', expectTool: 'wdk_get_address', expectCli: 'kaleido wallet address',
    templates: ['give me an address to receive bitcoin', 'I need a receive address', 'how do I get paid?', 'show me my deposit address'],
  },
  {
    id: 'channels', category: 'wallet', expectSkill: 'kaleido-wallet', expectTool: 'wdk_list_channels', expectCli: 'kaleido channel list',
    templates: ['show my lightning channels', 'list my channels', 'what channels do I have open?', 'channel status please'],
  },
  {
    id: 'node', category: 'wallet', expectSkill: 'kaleido-wallet', expectTool: 'wdk_get_node_info', expectCli: 'kaleido node info',
    templates: ['is my node synced?', 'node status', 'what is my node info?', 'is my lightning node online?'],
  },
  {
    id: 'send', category: 'wallet', expectSkill: 'kaleido-wallet', expectTool: 'wdk_pay_invoice', expectCli: 'kaleido pay',
    templates: ['pay {amount} sats to {contact}', 'send {contact} {amount} sats', 'send {amount} sats to {contact} please'],
    fill: (rng) => { const amount = pick(rng, AMOUNTS); const contact = pick(rng, CONTACTS); return { vars: { amount: String(amount), contact }, args: [String(amount)] }; },
  },
  {
    id: 'price', category: 'trading', expectSkill: 'kaleido-trading', expectTool: 'get_price', expectCli: 'kaleido price',
    templates: ["what's the bitcoin price?", 'how much is BTC worth right now?', 'current btc price in usd', 'price of bitcoin'],
  },
  {
    id: 'quote', category: 'trading', expectSkill: 'kaleido-trading', expectTool: 'kaleidoswap_get_quote', expectCli: 'kaleido quote',
    templates: ['quote me a swap of 0.001 {pair}', 'how much {pair} can I get for 0.001 BTC?', 'get a swap quote for {pair}'],
    fill: (rng) => { const pair = pick(rng, PAIRS); return { vars: { pair }, args: [pair.split('/')[1]!] }; },
  },
  {
    id: 'giftcard', category: 'commerce', expectSkill: 'bitrefill', expectTool: undefined, expectCli: undefined,
    templates: ['buy a $25 Amazon gift card with bitcoin', 'I want a Steam gift card', 'get me a mobile top-up', 'buy an eSIM for my trip'],
  },
  {
    id: 'explain', category: 'knowledge', expectTool: 'search_knowledge', expectCli: undefined,
    templates: ['how do I get inbound liquidity?', 'what is a submarine swap?', 'explain RGB assets', 'how do lightning channels work?'],
  },
  {
    id: 'remember', category: 'memory', expectTool: 'remember', expectCli: undefined,
    templates: ['remember that I prefer receiving on Lightning', 'note that my LSP is KaleidoSwap', 'save that I like sats over dollars'],
  },
  {
    id: 'recall', category: 'memory', expectTool: 'recall', expectCli: undefined,
    templates: ['what do you remember about me?', 'what are my preferences?', 'do you remember my LSP?'],
  },
  {
    id: 'greeting', category: 'negative', expectTool: null, expectCli: undefined,
    templates: ['hi there', 'thanks, that helps!', 'good morning', 'who are you?'],
  },
];

/** Generate the dataset: `perIntent` paraphrases per intent, seeded. */
export function generateDataset(seed = 42, perIntent = 4): EvalCase[] {
  const rng = mulberry32(seed);
  const cases: EvalCase[] = [];
  for (const intent of INTENTS) {
    for (let i = 0; i < perIntent; i++) {
      const tpl = intent.templates[i % intent.templates.length]!;
      const f = intent.fill?.(rng) ?? { vars: {} };
      const prompt = tpl.replace(/\{(\w+)\}/g, (_, k) => f.vars[k] ?? `{${k}}`);
      cases.push({
        id: `${intent.id}-${i}`,
        intent: intent.id,
        category: intent.category,
        prompt,
        expectSkill: intent.expectSkill,
        expectTool: intent.expectTool,
        expectCli: intent.expectCli,
        expectArgs: f.args,
      });
    }
  }
  return cases;
}

export const CATEGORIES: Category[] = ['wallet', 'trading', 'commerce', 'knowledge', 'memory', 'negative'];
