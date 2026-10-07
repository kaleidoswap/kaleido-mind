import { describe, it, expect, vi } from 'vitest';
import { extractIssueAsset, issueAssetRecipe } from './issue-asset.js';
import { runRecipe } from './runner.js';
import { Funnel } from '../funnel.js';
import { confirmReadback } from '../wallet/confirm.js';
import { MockWallet, scriptedProvider } from '../testing/index.js';

describe('extractIssueAsset (deterministic Tier-0)', () => {
  it('ticker + supply + quoted-less name', () => {
    expect(extractIssueAsset('issue 1000 TICKET tokens called Hackathon Ticket')).toEqual({
      name: 'Hackathon Ticket', ticker: 'TICKET', amount: 1000, schema: 'NIA',
    });
  });
  it('explicit ticker keyword and k shorthand', () => {
    expect(extractIssueAsset('mint 21k tokens named "Pizza Points" with ticker pizza')).toEqual({
      name: 'Pizza Points', ticker: 'PIZZA', amount: 21_000, schema: 'NIA',
    });
  });
  it('NFT → UDA with supply 1, ticker derived from the name', () => {
    expect(extractIssueAsset('mint an NFT called Genesis Badge')).toEqual({
      name: 'Genesis Badge', ticker: 'GENESISB', amount: 1, schema: 'UDA',
    });
  });
  it('Italian phrasing', () => {
    expect(extractIssueAsset('crea 500 token CAFE chiamati Caffè Club')).toEqual({
      name: 'Caffè Club', ticker: 'CAFE', amount: 500, schema: 'NIA',
    });
  });
  it('ignores invoices, channels, sends and swaps', () => {
    expect(extractIssueAsset('create an invoice for 10 USDT tokens')).toBeNull();
    expect(extractIssueAsset('create a channel with 100 USDT')).toBeNull();
    expect(extractIssueAsset('send 10 tokens to bob')).toBeNull();
    expect(extractIssueAsset('what is my balance')).toBeNull();
    expect(issueAssetRecipe.match!('buy 100 USDT tokens')).toBe(false);
  });
});

describe('extractIssueAsset — review regressions', () => {
  it('reads thousands separators in both styles, and decimals with k/m', () => {
    expect(extractIssueAsset('crea 1.000 token CAFE chiamati Caffè Club')).toMatchObject({ amount: 1000, ticker: 'CAFE', name: 'Caffè Club' });
    expect(extractIssueAsset('issue 1,000 TICKET tokens')).toMatchObject({ amount: 1000 });
    expect(extractIssueAsset('mint 1,5k PIZZA tokens')).toMatchObject({ amount: 1500 });
    expect(extractIssueAsset('mint 1.5k PIZZA tokens')).toMatchObject({ amount: 1500 });
  });
  it('never takes the supply from a number inside the name', () => {
    expect(extractIssueAsset('mint tokens named Web3 Summit 2026, supply 300')).toMatchObject({ name: 'Web3 Summit 2026', amount: 300 });
    expect(extractIssueAsset('mint tokens named Web3 Summit 2026')).toMatchObject({ name: 'Web3 Summit 2026', amount: undefined });
    expect(issueAssetRecipe.confident!(extractIssueAsset('mint tokens named Web3 Summit 2026')!)).toBe(false);
    expect(extractIssueAsset('launch a token called Moon with ticker MOON and 1m supply')).toMatchObject({ name: 'Moon', ticker: 'MOON', amount: 1_000_000 });
  });
  it('only fires when the request opens with the verb', () => {
    expect(issueAssetRecipe.match!('I have an issue with my USDT tokens')).toBe(false);
    expect(issueAssetRecipe.match!('how do I create a token?')).toBe(false);
    expect(extractIssueAsset('I have an issue with my USDT tokens')).toBeNull();
    expect(issueAssetRecipe.match!('please mint 100 PIZZA tokens')).toBe(true);
    expect(issueAssetRecipe.match!('puoi creare 100 token CAFE?')).toBe(true);
  });
  it('apostrophes inside a name are not quotes', () => {
    expect(extractIssueAsset("mint 100 tokens called Joe's Pizza with ticker 'JOE'")).toEqual({ name: "Joe's Pizza", ticker: 'JOE', amount: 100, schema: 'NIA' });
    expect(extractIssueAsset("crea 50 token chiamati Bottega dell'Arte con ticker ARTE")).toMatchObject({ name: "Bottega dell'Arte", ticker: 'ARTE', amount: 50 });
    expect(extractIssueAsset('mint 10 tokens "Pizza Points" ticker PP')).toMatchObject({ name: 'Pizza Points', ticker: 'PP', amount: 10 });
  });
});

describe('MockWallet.reset', () => {
  it('restores the initial state, including issued assets and UTXOs', async () => {
    const wallet = new MockWallet({ utxos: 1 });
    await wallet.registry().execute('rln_issue_asset', { name: 'Ticket', ticker: 'TICKET', amount: 10 });
    expect(wallet.utxos).toBe(0);
    wallet.reset();
    expect(wallet.utxos).toBe(1);
    expect(wallet.assets.TICKET).toBeUndefined();
    await expect(wallet.registry().execute('rln_issue_asset', { name: 'Ticket', ticker: 'TICKET', amount: 10 })).resolves.toMatchObject({ issued: true });
  });
});

describe('issue-asset readback', () => {
  it('fungible: supply + ticker + name', () => {
    expect(confirmReadback({ name: 'rln_issue_asset', arguments: { name: 'Hackathon Ticket', ticker: 'TICKET', amount: 1000 } }))
      .toBe('Issue 1,000 TICKET (Hackathon Ticket), a new RGB asset. Confirm?');
  });
  it('UDA: unique asset wording', () => {
    expect(confirmReadback({ name: 'rln_issue_asset', arguments: { name: 'Genesis Badge', ticker: 'GENESISB', amount: 1, schema: 'UDA' } }))
      .toBe('Issue unique asset GENESISB (Genesis Badge) on RGB. Confirm?');
  });
});

describe('runRecipe — issue asset against MockWallet', () => {
  it('one confirmation, asset lands in the wallet', async () => {
    const wallet = new MockWallet();
    const onConfirm = vi.fn(async () => ({ approved: true }));
    const res = await runRecipe(issueAssetRecipe, 'issue 1000 TICKET tokens called Hackathon Ticket', {
      provider: scriptedProvider(), tools: wallet.registry(), onConfirm,
    });
    expect(res.status).toBe('done');
    expect(res.inferences).toBe(0);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(wallet.assets.TICKET).toBe(1000);
    expect(res.text).toMatch(/^Issued 1000 TICKET\. Asset id: rgb:mock-ticket-/);
  });

  it('declined confirmation issues nothing', async () => {
    const wallet = new MockWallet();
    const res = await runRecipe(issueAssetRecipe, 'issue 1000 TICKET tokens', {
      provider: scriptedProvider(), tools: wallet.registry(), onConfirm: async () => ({ approved: false }),
    });
    expect(res.status).toBe('cancelled');
    expect(wallet.assets.TICKET).toBeUndefined();
  });

  it('surfaces the node-style "no UTXOs" failure', async () => {
    const wallet = new MockWallet({ utxos: 0 });
    const res = await runRecipe(issueAssetRecipe, 'issue 1000 TICKET tokens', {
      provider: scriptedProvider(), tools: wallet.registry(), onConfirm: async () => ({ approved: true }),
    });
    expect(res.status).toBe('error');
    expect(res.error ?? res.text).toMatch(/rln_create_utxos/);
  });
});

describe('Funnel — issue-asset as an opt-in recipe', () => {
  it('routes to the recipe tier and is listable afterwards', async () => {
    const wallet = new MockWallet();
    const funnel = new Funnel({ provider: scriptedProvider(), tools: wallet.registry(), recipes: [issueAssetRecipe] });
    const out = await funnel.runTurn('mint an NFT called Genesis Badge', { onConfirm: async () => ({ approved: true }) });
    expect(out.tier).toBe('recipe');
    expect(out.route).toBe('issue-asset');
    const listed = (await wallet.registry().execute('rln_list_assets', {})) as { assets: Array<{ ticker: string; schema: string }> };
    expect(listed.assets.find((a) => a.ticker === 'GENESISB')?.schema).toBe('UDA');
  });
});
