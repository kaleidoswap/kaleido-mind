import { describe, it, expect, vi } from 'vitest';
import { Engine } from './engine.js';
import { Funnel } from './funnel.js';
import { ToolRegistry } from './tools/registry.js';
import { InProcessToolSource } from './tools/in-process.js';
import { parseSkill, SkillRegistry } from './skills/registry.js';
import { scriptedProvider } from './testing/scripted-provider.js';
import { confirmReadback } from './wallet/confirm.js';
import {
  DECLINED_TOOL_MESSAGE,
  detectWalletAction,
  wantsToolCall,
  fixSatsBtcConversions,
  formatSatsAsBtc,
  findUngroundedPaymentData,
  hasCapableTool,
  validateToolArgs,
} from './guards.js';

const ISSUE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    ticker: { type: 'string' },
    amount: { type: 'number' },
    precision: { type: 'number', minimum: 0, maximum: 18 },
    schema: { type: 'string', enum: ['NIA', 'CFA', 'UDA'] },
  },
  required: ['name'],
};

const INVOICE = 'lnbcrt50u1pn9xyzpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq';

describe('validateToolArgs', () => {
  it('accepts valid args and coerces numeric strings', () => {
    const r = validateToolArgs({ name: 'rln_issue_asset', parameters: ISSUE_SCHEMA }, { name: 'Hack', ticker: 'HCK', amount: '1000' });
    expect(r.ok).toBe(true);
    expect(r.args.amount).toBe(1000);
  });

  it('rejects the garbled issue call from the live test', () => {
    const r = validateToolArgs({ name: 'rln_issue_asset', parameters: ISSUE_SCHEMA }, { name: 'Hack', ticker: "HCK', " });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/amount/);
    expect(r.errors.join(' ')).toMatch(/ticker/);
  });

  it('flags missing required fields, wrong types, enums, ranges and non-finite numbers', () => {
    const def = { name: 'x', parameters: ISSUE_SCHEMA };
    expect(validateToolArgs(def, {}).errors).toContain('"name" is required');
    expect(validateToolArgs(def, { name: 1 }).ok).toBe(false);
    expect(validateToolArgs(def, { name: 'a', schema: 'ERC20' }).ok).toBe(false);
    expect(validateToolArgs(def, { name: 'a', precision: 19 }).ok).toBe(false);
    expect(validateToolArgs(def, { name: 'a', amount: Number.NaN }).ok).toBe(false);
    expect(validateToolArgs(def, { name: 'a', amount: 'lots' }).ok).toBe(false);
  });

  it('passes through tools without a JSON schema', () => {
    expect(validateToolArgs({ name: 'x', parameters: {} }, { anything: 1 }).ok).toBe(true);
  });

  it('uses safeParse for Zod-like schemas', () => {
    const zodLike = { safeParse: (v: any) => (v.n ? { success: true } : { success: false, error: { issues: [{ path: ['n'], message: 'Required' }] } }) };
    expect(validateToolArgs({ name: 'x', parameters: zodLike }, {}).errors).toEqual(['n: Required']);
    expect(validateToolArgs({ name: 'x', parameters: zodLike }, { n: 1 }).ok).toBe(true);
  });
});

describe('confirmReadback never shows NaN', () => {
  it('describes a missing amount instead of NaN and strips stray quotes', () => {
    const line = confirmReadback({ name: 'rln_issue_asset', arguments: { name: 'Hack', ticker: "HCK', " } });
    expect(line).not.toMatch(/NaN/);
    expect(line).toBe('Issue an unspecified amount of HCK (Hack), a new RGB asset. Confirm?');
    expect(confirmReadback({ name: 'spark_send', arguments: { to: 'bob' } })).not.toMatch(/NaN/);
  });
});

describe('findUngroundedPaymentData / detectWalletAction', () => {
  it('finds invoices and addresses no source contains', () => {
    expect(findUngroundedPaymentData(`Here: ${INVOICE}`, [])).toEqual([{ kind: 'Lightning invoice', value: INVOICE }]);
    expect(findUngroundedPaymentData(`Here: ${INVOICE}`, [{ invoice: INVOICE }])).toEqual([]);
    expect(findUngroundedPaymentData('Send to tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', [])).toHaveLength(1);
    expect(findUngroundedPaymentData('You have 5,000 sats.', [])).toEqual([]);
  });

  it('detects wallet actions and capable tools', () => {
    const a = detectWalletAction('Create a Lightning invoice for 5000 sats')!;
    expect(a.id).toBe('receive-invoice');
    expect(hasCapableTool(a, ['bitrefill_create_invoice', 'get_price'])).toBe(false);
    expect(hasCapableTool(a, ['rln_create_ln_invoice'])).toBe(true);
    expect(detectWalletAction('what is the BTC price?')).toBeNull();
  });

  it('detects asset issuance', () => {
    const a = detectWalletAction('issue a new asset HCK with 1000 units')!;
    expect(a.id).toBe('issue-asset');
    expect(hasCapableTool(a, ['rln_list_assets'])).toBe(false);
    expect(hasCapableTool(a, ['rln_issue_asset'])).toBe(true);
  });

  it('wantsToolCall: actions yes, how-to questions no', () => {
    expect(wantsToolCall('send 1000 sats to bob')).toBe(true);
    expect(wantsToolCall('Can you create an invoice for 5000 sats?')).toBe(true);
    expect(wantsToolCall('how do I send sats to someone?')).toBe(false);
    expect(wantsToolCall('what is the BTC price?')).toBe(false);
  });
});

function engineWith(
  tools: ConstructorParameters<typeof InProcessToolSource>[1],
  turns: Parameters<typeof scriptedProvider>[0],
  opts: Partial<ConstructorParameters<typeof Engine>[0]> = {},
) {
  return new Engine({ provider: scriptedProvider(turns), tools: new ToolRegistry([new InProcessToolSource('t', tools)]), ...opts });
}

const LIST_ASSETS_RESULT = [
  {
    asset_id: 'rgb:rXXZqZR5-g9x7NDo-fXkijg3-BhJAbGd-Y24H0f2-Rgw1PkE', ticker: 'Q35A', name: 'Bench Q35A', details: null, precision: 0,
    issued_supply: 1_000_000, balance: { settled: 1_000_000, future: 1_000_000, spendable: 1_000_000, offchain_outbound: 0, offchain_inbound: 0 },
  },
  {
    asset_id: 'rgb:WBq3wXtG-xG8XBXq-ALV6AP3-wL6qamB-_X4StEv-Jaxl~ME', ticker: 'QNINE', name: 'Bench QNINE', details: null, precision: 0,
    issued_supply: 1_000_000, balance: { settled: 1_000_000, future: 1_000_000, spendable: 1_000_000, offchain_outbound: 0, offchain_inbound: 0 },
  },
];

describe('Engine guards', () => {
  it('F2: answers from the cached result instead of re-running an identical call, then forces an answer', async () => {
    const list = vi.fn(async () => ({ assets: [] }));
    const engine = engineWith(
      [{ name: 'rln_list_assets', description: '', parameters: {}, handler: list }],
      [
        { tool: 'rln_list_assets' },
        { tool: 'rln_list_assets' },
        { tool: 'rln_list_assets' },
        { text: 'You have no RGB assets yet.' },
      ],
    );
    const res = await engine.runAgentic([{ role: 'user', content: 'list my assets' }], { maxTurns: 5 });
    expect(list).toHaveBeenCalledTimes(1);
    expect(res.toolCalls[1]!.result).toMatchObject({ error: expect.stringMatching(/You already called rln_list_assets/) });
    expect(res.text).toBe('You have no RGB assets yet.');
    expect(res.turns).toBe(3);
  });

  it('F2: a confirm-gated call in between allows the same read again', async () => {
    const list = vi.fn(async () => ({ assets: [] }));
    const engine = engineWith(
      [
        { name: 'rln_list_assets', description: '', parameters: {}, handler: list },
        { name: 'rln_issue_asset', description: '', parameters: ISSUE_SCHEMA, requiresConfirmation: true, handler: async () => ({ asset_id: 'rgb:x' }) },
      ],
      [
        { tool: 'rln_list_assets' },
        { tool: 'rln_issue_asset', args: { name: 'Hack', ticker: 'HCK', amount: 10 } },
        { tool: 'rln_list_assets' },
        { text: 'done' },
      ],
    );
    await engine.runAgentic([{ role: 'user', content: 'issue' }], { onConfirm: async () => ({ approved: true }) });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('F3: invalid args go back to the model as a tool error and never reach onConfirm', async () => {
    const issue = vi.fn(async () => ({ asset_id: 'rgb:x' }));
    const onConfirm = vi.fn(async () => ({ approved: true }));
    const engine = engineWith(
      [{ name: 'rln_issue_asset', description: '', parameters: ISSUE_SCHEMA, requiresConfirmation: true, handler: issue }],
      [{ tool: 'rln_issue_asset', args: { name: 'Hack', ticker: "HCK', " } }, { text: 'How many tokens should I issue?' }],
    );
    const res = await engine.runAgentic([{ role: 'user', content: 'issue HCK' }], { onConfirm });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
    expect(res.toolCalls[0]!.result).toMatchObject({ error: expect.stringMatching(/Invalid arguments.*amount/) });
    expect(res.text).toBe('How many tokens should I issue?');
  });

  it('F3: valid args reach onConfirm coerced, with a readback summary', async () => {
    const onConfirm = vi.fn(async (_c: { name: string; arguments: Record<string, unknown>; summary?: string }) => ({ approved: true }));
    const engine = engineWith(
      [{ name: 'rln_issue_asset', description: '', parameters: ISSUE_SCHEMA, requiresConfirmation: true, handler: async () => ({ asset_id: 'rgb:x' }) }],
      [{ tool: 'rln_issue_asset', args: { name: 'Hack', ticker: 'HCK', amount: '1000' } }, { text: 'Issued.' }],
    );
    await engine.runAgentic([{ role: 'user', content: 'issue 1000 HCK' }], { onConfirm });
    expect(onConfirm.mock.calls[0]![0]).toMatchObject({
      arguments: { amount: 1000 },
      summary: 'Issue 1,000 HCK (Hack), a new RGB asset. Confirm?',
    });
  });

  it('F4: a decline feeds the model an unambiguous message', async () => {
    const engine = engineWith(
      [{ name: 'rln_send_btc', description: '', parameters: {}, requiresConfirmation: true, handler: async () => ({ txid: 'x' }) }],
      [{ tool: 'rln_send_btc', args: { address: 'tb1q', amount_sat: 1000 } }, { text: 'Cancelled.' }],
    );
    const res = await engine.runAgentic([{ role: 'user', content: 'send' }], { onConfirm: async () => ({ approved: false }) });
    expect(res.toolCalls[0]!.result).toEqual({ status: 'cancelled_by_user', declined_by: 'user', tool: 'rln_send_btc', message: DECLINED_TOOL_MESSAGE });
    expect(res.messages.find((m) => m.role === 'tool')!.content).toContain('Cancelled by the user');
    expect(res.text).toBe('Cancelled — you declined: Send 1,000 sats on-chain to tb1q over RLN. Nothing was sent or changed.');
    expect(res.turns).toBe(1);
  });

  it('F4: declining rln_create_utxos ends the turn without letting the model blame the node', async () => {
    const utxos = vi.fn(async () => ({ created: 5 }));
    const engine = engineWith(
      [{ name: 'rln_create_utxos', description: '', parameters: {}, requiresConfirmation: true, handler: utxos }],
      [{ tool: 'rln_create_utxos', args: {} }, { text: 'The node declined the UTXO creation.' }],
    );
    const res = await engine.runAgentic([{ role: 'user', content: 'create utxos' }], { onConfirm: async () => ({ approved: false }) });
    expect(utxos).not.toHaveBeenCalled();
    expect(res.text).toBe('Cancelled — you declined: Create 5 RGB UTXOs on-chain over RLN. Nothing was sent or changed.');
  });

  it('keeps a realistic asset-list answer with rgb: asset ids intact', async () => {
    const answer =
      'You hold 2 RGB assets: | Asset ID | Ticker | Balance | |---|---|---| ' +
      '| rgb:rXXZqZR5-g9x7NDo-fXkijg3-BhJAbGd-Y24H0f2-Rgw1PkE | Q35A | 1,000,000 | ' +
      '| rgb:WBq3wXtG-xG8XBXq-ALV6AP3-wL6qamB-_X4StEv-Jaxl~ME | QNINE | 1,000,000 |. Truncated: rgb:WBq3wXtG-xG8X';
    const engine = engineWith(
      [{ name: 'rln_list_assets', description: '', parameters: { type: 'object', properties: { schemas: { type: 'array' } } }, handler: async () => LIST_ASSETS_RESULT }],
      [{ tool: 'rln_list_assets', args: { schemas: [] } }, { text: answer }],
      { compressToolOutput: true },
    );
    const res = await engine.runAgentic([{ role: 'user', content: 'Which RGB assets do I hold, and what are the balances?' }]);
    expect(res.text).toBe(answer);
  });

  it('recovers when the answer turn comes back empty (reasoning ate the output budget)', async () => {
    const turns = [
      { text: '', toolCalls: [{ name: 'rln_list_assets', arguments: {} }] },
      { text: '', toolCalls: [], incomplete: true },
      { text: 'You hold Q35A and QNINE, 1,000,000 each.', toolCalls: [] },
    ];
    let i = 0;
    const provider = { name: 'p', runTurn: vi.fn(async () => ({ rawContent: '', ...turns[i++]! })) };
    const engine = new Engine({ provider, tools: new ToolRegistry([new InProcessToolSource('t', [{ name: 'rln_list_assets', description: '', parameters: {}, handler: async () => LIST_ASSETS_RESULT }])]) });
    const res = await engine.runAgentic([{ role: 'user', content: 'Which RGB assets do I hold?' }]);
    expect(res.text).toBe('You hold Q35A and QNINE, 1,000,000 each.');
    expect(provider.runTurn.mock.calls[2]![0].tools).toEqual([]);
  });

  it('falls back to the tool result when the recovery turn is empty too', async () => {
    const engine = engineWith(
      [{ name: 'rln_list_assets', description: '', parameters: {}, handler: async () => LIST_ASSETS_RESULT }],
      [{ tool: 'rln_list_assets' }, { text: '' }, { text: '' }],
    );
    const res = await engine.runAgentic([{ role: 'user', content: 'Which RGB assets do I hold?' }]);
    expect(res.text).toMatch(/^I couldn't phrase an answer in time\. Here is what rln list assets returned:/);
    expect(res.text).toContain('Q35A');
  });

  it('F1: refuses a wallet action with no capable tool before any inference', async () => {
    const provider = scriptedProvider([{ text: `Here is your invoice: ${INVOICE}` }]);
    const runTurn = vi.spyOn(provider, 'runTurn');
    const engine = new Engine({
      provider,
      tools: new ToolRegistry([new InProcessToolSource('t', [{ name: 'bitrefill_create_invoice', description: '', parameters: {}, handler: async () => ({}) }])]),
    });
    const res = await engine.runAgentic([{ role: 'user', content: 'Create a Lightning invoice for 5000 sats' }]);
    expect(runTurn).not.toHaveBeenCalled();
    expect(res.turns).toBe(0);
    expect(res.text).toMatch(/no tool for creating an invoice/);
  });

  it('F1: replaces an invoice the model made up', async () => {
    const engine = engineWith([], [{ text: `Here is your invoice: ${INVOICE}` }], { guardMissingTools: false });
    const res = await engine.runAgentic([{ role: 'user', content: 'Create a Lightning invoice for 5000 sats' }]);
    expect(res.text).not.toContain(INVOICE);
    expect(res.text).toMatch(/won't make one up/);
  });

  it('F1: keeps an invoice a tool returned', async () => {
    const engine = engineWith(
      [{ name: 'rln_create_ln_invoice', description: '', parameters: {}, handler: async () => ({ invoice: INVOICE }) }],
      [{ tool: 'rln_create_ln_invoice', args: { amount_sats: 5000 } }, { text: `Here is your invoice: ${INVOICE}` }],
    );
    const res = await engine.runAgentic([{ role: 'user', content: 'Create a Lightning invoice for 5000 sats' }]);
    expect(res.text).toContain(INVOICE);
  });
});

const SPARK_SKILL = parseSkill([
  '---',
  'name: spark-wallet',
  'description: Spark wallet — create a Spark Lightning invoice, pay invoices.',
  'tools: spark_create_invoice, spark_get_balance, bitrefill_search',
  'triggers: spark, lightning invoice, ln invoice',
  'requires-tools: spark_get_balance',
  '---',
  'Use spark tools.',
].join('\n'));

const RLN_SKILL = parseSkill([
  '---',
  'name: rgb-lightning-node',
  'description: Drive the RGB Lightning Node.',
  'tools: rln_create_ln_invoice, rln_list_assets',
  'triggers: invoice, node',
  '---',
  'Use rln tools.',
].join('\n'));

describe('Engine.composeSkill', () => {
  it('skips a skill whose requires-tools are not in the registry (no app wiring needed)', async () => {
    const engine = new Engine({
      provider: scriptedProvider([]),
      tools: new ToolRegistry([
        new InProcessToolSource('t', [
          { name: 'bitrefill_search', description: '', parameters: {}, handler: async () => ({}) },
          { name: 'rln_create_ln_invoice', description: '', parameters: {}, handler: async () => ({}) },
        ]),
      ]),
    });
    const skills = new SkillRegistry([SPARK_SKILL, RLN_SKILL]);
    expect(skills.select('Create a Lightning invoice for 5000 sats')?.name).toBe('spark-wallet');
    const composed = await engine.composeSkill(skills, 'Create a Lightning invoice for 5000 sats', 'base');
    expect(composed.skill?.name).toBe('rgb-lightning-node');
    expect(composed.system).toContain('Active skill: rgb-lightning-node');
    expect(composed.allowedTools).toContain('rln_create_ln_invoice');
  });
});

describe('Funnel F1 guards', () => {
  it('skips a skill whose required tools are missing and picks one that can act', async () => {
    const tools = new ToolRegistry([
      new InProcessToolSource('t', [
        { name: 'bitrefill_search', description: '', parameters: {}, handler: async () => ({}) },
        { name: 'rln_create_ln_invoice', description: '', parameters: {}, handler: async () => ({ invoice: INVOICE }) },
      ]),
    ]);
    const funnel = new Funnel({
      provider: scriptedProvider([{ tool: 'rln_create_ln_invoice', args: { amount_sats: 5000 } }, { text: `Invoice: ${INVOICE}` }]),
      tools,
      skills: [SPARK_SKILL, RLN_SKILL],
      recipes: [],
      fastIntents: [],
    });
    const res = await funnel.runTurn('Create a Lightning invoice for 5000 sats');
    expect(res.route).toBe('rgb-lightning-node');
    expect(res.text).toContain(INVOICE);
  });

  it('refuses without inference when no tool can create an invoice', async () => {
    const provider = { ...scriptedProvider([{ text: `Invoice: ${INVOICE}` }]) };
    const runTurn = vi.spyOn(provider, 'runTurn');
    const funnel = new Funnel({
      provider,
      tools: new ToolRegistry([
        new InProcessToolSource('t', [
          { name: 'bitrefill_create_invoice', description: '', parameters: {}, handler: async () => ({}) },
          { name: 'spark_get_balance', description: '', parameters: {}, handler: async () => ({}) },
        ]),
      ]),
      skills: [SPARK_SKILL],
      recipes: [],
      fastIntents: [],
    });
    const res = await funnel.runTurn('Create a Lightning invoice for 5000 sats');
    expect(runTurn).not.toHaveBeenCalled();
    expect(res.route).toBe('no-tool');
    expect(res.text).toMatch(/no tool for creating an invoice/);
  });
});

describe('fixSatsBtcConversions', () => {
  it('recomputes a wrong BTC figure from the sats figure', () => {
    expect(fixSatsBtcConversions('Vanilla UTXOs: 4,277 sats (42.77 BTC)')).toBe('Vanilla UTXOs: 4,277 sats (0.00004277 BTC)');
    expect(fixSatsBtcConversions('0.5 BTC (5,000 sats)')).toBe('0.00005 BTC (5,000 sats)');
    expect(fixSatsBtcConversions('You have **300,000 satoshis** (3 BTC) on-chain.')).toBe('You have **300,000 satoshis** (0.003 BTC) on-chain.');
    expect(fixSatsBtcConversions('**0.5 BTC** (5,000 sats)')).toBe('**0.00005 BTC** (5,000 sats)');
  });

  it('leaves correct pairs and lone amounts alone', () => {
    const ok = 'You have 150,000,000 sats (1.5 BTC) and 0.001 BTC (100,000 sats). Fee: 300 sats.';
    expect(fixSatsBtcConversions(ok)).toBe(ok);
  });

  it('formats sats as BTC without trailing zeros', () => {
    expect(formatSatsAsBtc(100_000_000)).toBe('1');
    expect(formatSatsAsBtc(4_277)).toBe('0.00004277');
    expect(formatSatsAsBtc(0)).toBe('0');
  });
});

describe('engine replies skip the answer guards', () => {
  it('a declined send keeps its cancel message even though the readback shortens the invoice', async () => {
    const to = 'rgb:~/~/~/sig/any/1/utxob:test-recipient';
    const engine = engineWith(
      [{ name: 'rln_send_asset', description: '', parameters: {}, requiresConfirmation: true, handler: async () => ({ ok: true }) }],
      [{ tool: 'rln_send_asset', args: { asset: 'USDT', amount: 1, to } }, { text: 'unused' }],
    );
    const res = await engine.runAgentic([{ role: 'user', content: `Send 1 USDT to this RGB invoice: ${to}` }], {
      onConfirm: async () => ({ approved: false, reason: 'no' }),
    });
    expect(res.text).toMatch(/^Cancelled — you declined/);
    expect(res.text).not.toMatch(/won't make one up/);
  });
});
