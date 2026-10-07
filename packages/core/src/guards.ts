/**
 * Agent guards — deterministic checks around the model's tool use, so a small
 * local model can't turn a bad tool call into a bad user experience:
 *
 *  - validateToolArgs: check a call against the tool's JSON Schema (or Zod
 *    schema) before it reaches the confirmation gate.
 *  - findUngroundedPaymentData: payment requests/addresses in a reply that no
 *    tool returned and the user never typed — i.e. made up by the model.
 *  - detectWalletAction / hasCapableTool: refuse a wallet action up front when
 *    no tool in scope can perform it.
 */

import type { ToolDef } from './types.js';

type Obj = Record<string, any>;

export interface ArgValidation {
  ok: boolean;
  /** Arguments with numeric/boolean strings coerced to the schema's type. */
  args: Record<string, unknown>;
  errors: string[];
}

function isZodLike(p: unknown): p is { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: any } } {
  return !!p && typeof p === 'object' && typeof (p as Obj).safeParse === 'function';
}

function schemaType(s: Obj): string | undefined {
  if (Array.isArray(s.type)) return s.type.find((t: unknown) => t !== 'null');
  if (typeof s.type === 'string') return s.type;
  for (const alt of [...(s.anyOf ?? []), ...(s.oneOf ?? [])]) {
    if (alt && typeof alt === 'object' && alt.type !== 'null') return schemaType(alt);
  }
  return undefined;
}

function checkValue(key: string, value: unknown, s: Obj): { value: unknown; error?: string } {
  const type = schemaType(s);
  let v = value;
  if (type === 'number' || type === 'integer') {
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
    if (typeof v !== 'number' || !Number.isFinite(v)) return { value, error: `"${key}" must be a finite number` };
    if (type === 'integer' && !Number.isInteger(v)) return { value, error: `"${key}" must be an integer` };
    if (typeof s.minimum === 'number' && v < s.minimum) return { value, error: `"${key}" must be ≥ ${s.minimum}` };
    if (typeof s.maximum === 'number' && v > s.maximum) return { value, error: `"${key}" must be ≤ ${s.maximum}` };
  } else if (type === 'boolean') {
    if (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) v = v.trim().toLowerCase() === 'true';
    if (typeof v !== 'boolean') return { value, error: `"${key}" must be true or false` };
  } else if (type === 'string') {
    if (typeof v !== 'string') return { value, error: `"${key}" must be a string` };
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(v)) {
      return { value, error: `"${key}" does not match the expected format` };
    }
  } else if (type === 'array') {
    if (!Array.isArray(v)) return { value, error: `"${key}" must be an array` };
  } else if (type === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { value, error: `"${key}" must be an object` };
  }
  if (Array.isArray(s.enum) && !s.enum.includes(v)) {
    return { value, error: `"${key}" must be one of ${s.enum.map((e: unknown) => JSON.stringify(e)).join(', ')}` };
  }
  return { value: v };
}

/** Tool-specific rules the published schemas can't express (conditional requirements). */
const SEMANTIC_RULES: Record<string, (a: Record<string, unknown>) => string[]> = {
  rln_issue_asset: (a) => {
    const errors: string[] = [];
    const schema = String(a.schema ?? 'NIA').toUpperCase();
    if (schema !== 'UDA' && a.amount == null) errors.push('"amount" (total supply) is required for NIA and CFA assets');
    if (schema !== 'CFA') {
      if (a.ticker == null) errors.push('"ticker" is required for NIA and UDA assets');
      else if (!/^[A-Z0-9]{1,8}$/.test(String(a.ticker))) errors.push('"ticker" must be 1–8 uppercase letters or digits');
    }
    if (typeof a.amount === 'number' && a.amount <= 0) errors.push('"amount" must be greater than 0');
    return errors;
  },
};
SEMANTIC_RULES.wdk_issue_asset = SEMANTIC_RULES.rln_issue_asset!;

/**
 * Validate (and lightly coerce) a tool call's arguments against its schema.
 * Unknown schema shapes pass through unchanged.
 */
export function validateToolArgs(def: Pick<ToolDef, 'name' | 'parameters'>, rawArgs: unknown): ArgValidation {
  const args: Record<string, unknown> =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? { ...(rawArgs as Obj) } : {};
  if (rawArgs != null && (typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
    return { ok: false, args, errors: ['arguments must be a JSON object'] };
  }
  const p = def.parameters as Obj | undefined;
  const errors: string[] = [];

  if (isZodLike(p)) {
    const r = p.safeParse(args);
    if (!r.success) {
      const issues: Obj[] = r.error?.issues ?? [];
      errors.push(...(issues.length
        ? issues.map((i) => `${(i.path ?? []).join('.') || 'arguments'}: ${i.message}`)
        : ['arguments do not match the tool schema']));
    }
  } else if (p && typeof p === 'object' && (p.properties || p.required)) {
    const props: Obj = p.properties ?? {};
    for (const key of Array.isArray(p.required) ? p.required : []) {
      if (args[key] == null || args[key] === '') errors.push(`"${key}" is required`);
    }
    for (const [key, value] of Object.entries(args)) {
      const s = props[key];
      if (value == null) continue;
      if (!s) {
        if (p.additionalProperties === false) errors.push(`unknown argument "${key}"`);
        continue;
      }
      const r = checkValue(key, value, s);
      if (r.error) errors.push(r.error);
      else args[key] = r.value;
    }
  }

  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'number' && !Number.isFinite(value)) errors.push(`"${key}" must be a finite number`);
  }
  const rule = SEMANTIC_RULES[def.name];
  if (rule && errors.length === 0) errors.push(...rule(args));
  return { ok: errors.length === 0, args, errors: [...new Set(errors)] };
}

/** Payment requests and addresses a model must never make up. */
const PAYMENT_DATA: Array<{ kind: string; re: RegExp }> = [
  { kind: 'Lightning invoice', re: /\bln(?:bc|tb|bcrt|tbs|sb)[0-9a-z]{20,}\b/gi },
  { kind: 'Lightning offer', re: /\blno1[0-9a-z]{20,}\b/gi },
  { kind: 'LNURL', re: /\blnurl1[0-9a-z]{20,}\b/gi },
  { kind: 'RGB invoice', re: /\brgb:[^\s`'"<>)]{20,}/gi },
  { kind: 'blinded UTXO', re: /\butxob:[^\s`'"<>)]{10,}/gi },
  { kind: 'Spark address', re: /\bspark(?:rt|t|s)?1[0-9a-z]{20,}\b/gi },
  { kind: 'Ark address', re: /\b(?:t?ark)1[0-9a-z]{20,}\b/gi },
  { kind: 'Liquid address', re: /\b(?:lq1|ex1|tlq1|tex1|el1|ert1)[0-9a-z]{20,}\b/gi },
  { kind: 'Bitcoin address', re: /\b(?:bc1|tb1|bcrt1)[0-9a-z]{20,}\b/gi },
];

export interface UngroundedItem {
  kind: string;
  value: string;
}

/**
 * Payment strings in `text` that do not occur in any of the `sources` (tool
 * results, user and history messages). Comparison is case-insensitive.
 */
export function findUngroundedPaymentData(text: string, sources: unknown[]): UngroundedItem[] {
  if (!text) return [];
  const haystack = sources
    .map((s) => (typeof s === 'string' ? s : (() => { try { return JSON.stringify(s); } catch { return ''; } })()))
    .join('\n')
    .toLowerCase();
  const out: UngroundedItem[] = [];
  const seen = new Set<string>();
  for (const { kind, re } of PAYMENT_DATA) {
    for (const m of text.matchAll(re)) {
      const value = m[0];
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (!haystack.includes(key)) out.push({ kind, value });
    }
  }
  return out;
}

export function ungroundedReply(items: UngroundedItem[]): string {
  const kinds = [...new Set(items.map((i) => i.kind))].join(' / ');
  return `I can't give you that ${kinds}: no tool produced it in this conversation, and I won't make one up. ` +
    'Make sure the wallet that should create it is connected, then ask again.';
}

const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`;
const SATS = String.raw`(?:sats?|satoshis)`;
const SATS_THEN_BTC = new RegExp(String.raw`${NUM}\s*${SATS}(\s*\(\s*~?\s*)${NUM}(\s*BTC\b)`, 'gi');
const BTC_THEN_SATS = new RegExp(String.raw`${NUM}(\s*BTC\s*\(\s*~?\s*)${NUM}(\s*${SATS}\b)`, 'gi');

const toNumber = (s: string): number => Number(s.replace(/,/g, ''));

/** Sats as a BTC decimal string, without trailing zeros. */
export function formatSatsAsBtc(sats: number): string {
  return (sats / 1e8).toFixed(8).replace(/\.?0+$/, '');
}

const sameBtc = (btc: number, sats: number) => Math.abs(btc * 1e8 - sats) < 0.5;

/**
 * Small models get sats↔BTC conversions wrong ("4,277 sats (42.77 BTC)").
 * Where the answer pairs a sats amount with a BTC amount, recompute the BTC
 * figure from the sats figure, which is the one copied from the tool result.
 */
export function fixSatsBtcConversions(text: string): string {
  return text
    .replace(SATS_THEN_BTC, (m, sats: string, mid: string, btc: string, unit: string) =>
      sameBtc(toNumber(btc), toNumber(sats)) ? m : m.replace(`${mid}${btc}${unit}`, `${mid}${formatSatsAsBtc(toNumber(sats))}${unit}`))
    .replace(BTC_THEN_SATS, (m, btc: string, _mid: string, sats: string) =>
      sameBtc(toNumber(btc), toNumber(sats)) ? m : `${formatSatsAsBtc(toNumber(sats))}${m.slice(btc.length)}`);
}

/** A wallet action the user asked for, and how to recognise a tool that can do it. */
export interface WalletAction {
  id: 'receive-invoice' | 'receive-address' | 'pay' | 'send' | 'issue-asset';
  label: string;
  tool: RegExp;
}

const WALLET_ACTIONS: Array<WalletAction & { request: RegExp }> = [
  {
    id: 'receive-invoice',
    label: 'creating an invoice',
    request: /\b(create|make|generate|new|give me|get me|send me|i need|request)\b[^.?!]*\binvoice\b|\binvoice\b[^.?!]*\bfor\s+\d/i,
    tool: /(^|_)create_(ln_|lightning_|rgb_)?invoice$|(^|_)receive(_|$)|_invoice_create$/i,
  },
  {
    id: 'receive-address',
    label: 'getting a receive address',
    request: /\b(my|new|receive|receiving|deposit|funding|give me|get me|show me)\b[^.?!]*\baddress\b/i,
    tool: /address/i,
  },
  {
    id: 'pay',
    label: 'paying an invoice',
    request: /\bpay\b[^.?!]*\b(invoice|lnbc|lntb|lnbcrt|lno1|bolt11|bolt12|offer)/i,
    tool: /pay/i,
  },
  {
    id: 'send',
    label: 'sending funds',
    request: /\bsend\b[^.?!]*\b(\d|sats?|btc|usdt|xaut|asset|to)\b/i,
    tool: /send|pay|transfer/i,
  },
  {
    id: 'issue-asset',
    label: 'issuing an asset',
    request: /\b(issue|mint|create)\b[^.?!]*\b(asset|token|coin|nia|cfa|uda)\b/i,
    tool: /issue_asset/i,
  },
];

const HOW_TO_QUESTION = /^\s*(how|what|why|when|where|which|who)\b/i;

/**
 * True when the request is a wallet action the model should act on with a
 * tool right away — not a question about how such an action works.
 */
export function wantsToolCall(text: string): boolean {
  return detectWalletAction(text) !== null && !HOW_TO_QUESTION.test(text);
}

/** The wallet action a request asks for, or null. Payment tools from commerce sources don't count. */
export function detectWalletAction(text: string): WalletAction | null {
  const hit = WALLET_ACTIONS.find((a) => a.request.test(text));
  return hit ? { id: hit.id, label: hit.label, tool: hit.tool } : null;
}

const NON_WALLET_PREFIXES = /^(bitrefill_|l402_|mpp_|search_|read_skill_reference$|remember$|recall$)/;

export function hasCapableTool(action: WalletAction, toolNames: string[]): boolean {
  return toolNames.some((n) => !NON_WALLET_PREFIXES.test(n) && action.tool.test(n));
}

export function noToolReply(action: WalletAction): string {
  return `I can't do that here: no tool for ${action.label} is available, so I won't make anything up. ` +
    'Connect a wallet that supports it and ask again.';
}

/** The text fed back to the model when the user declines at the confirmation gate. */
export const DECLINED_TOOL_MESSAGE =
  'The user declined this action at the confirmation prompt. Nothing was sent or changed. ' +
  'Tell the user it was cancelled. Do not retry it and do not say anyone else declined it.';

/** Stable key for a tool call: name + canonical JSON of its arguments. */
export function callKey(name: string, args: Record<string, unknown>): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v as Obj).sort().map((k) => [k, canon((v as Obj)[k])]))
        : v;
  return `${name}:${JSON.stringify(canon(args ?? {}))}`;
}
