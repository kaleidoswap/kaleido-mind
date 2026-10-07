/**
 * A stateful mock wallet — balances per layer, contacts (incl. ambiguous +
 * injectable), a price, validation (insufficient funds, no route, unknown
 * contact, no colored UTXOs), RGB issuance, and a record of what actually got
 * "sent". The canonical contract tools bind to it, so the agent sees real
 * schemas and real failure modes — not trivial canned stubs.
 *
 * Used by the eval harness and exported as `@kaleidorg/mind/testing` so hosts
 * can build and demo an agent with no node, no funds and no network.
 */

import { bindWalletTools, type WalletHandler } from '../wallet/contract.js';
import { ToolRegistry } from '../tools/registry.js';
import { bindSubmarineTools, type SubmarineHandler } from '../submarine/contract.js';

export interface SendRecord {
  tool: string;
  to: string;
  amount_sats?: number;
  asset?: string;
  amount?: number;
}
export interface MockContact { name: string; ln_address: string; note?: string }
export interface MockWalletOptions {
  priceUsd?: number;
  failRoute?: boolean;
  contacts?: MockContact[];
  balances?: { spark: number; rln: number; arkade: number };
  assets?: Record<string, number>;
  /** Free colored UTXOs on the RLN node (issuance / RGB receive consume one). */
  utxos?: number;
  /** Liquid balances in smallest units (L-USDT: 8 decimals, L-BTC: sats) for submarine swaps. */
  liquid?: { 'L-USDT': number; 'L-BTC': number };
}
export interface MockRgbAsset {
  asset_id: string;
  ticker: string;
  name: string;
  precision: number;
  schema: 'NIA' | 'CFA' | 'UDA';
  issued_supply: number;
}
export interface MockTransfer {
  idx: number;
  asset_id: string;
  kind: 'Issuance' | 'Send' | 'ReceiveBlind';
  status: 'Settled' | 'WaitingCounterparty';
  amount: number;
}

export class MockWallet {
  priceUsd: number;
  failRoute: boolean;
  balances: { spark: number; rln: number; arkade: number };
  assets: Record<string, number>;
  contacts: MockContact[];
  utxos: number;
  liquid: { 'L-USDT': number; 'L-BTC': number };
  /** Submarine swaps opened against the mock /v2 maker, by id. */
  submarineSwaps: Record<string, { from: 'L-USDT' | 'L-BTC'; invoice: string; expected: number; funded: boolean }> = {};
  /** RGB assets the node knows about (seeded USDT/XAUT + anything issued). */
  rgbAssets: MockRgbAsset[];
  transfers: MockTransfer[] = [];
  sends: SendRecord[] = [];

  private readonly opts: MockWalletOptions;

  constructor(o: MockWalletOptions = {}) {
    this.opts = o;
    this.priceUsd = o.priceUsd ?? 65_000;
    this.failRoute = o.failRoute ?? false;
    // Copies: the wallet mutates its state, and reset() rebuilds from `o`.
    this.balances = { ...(o.balances ?? { spark: 500_000, rln: 300_000, arkade: 200_000 }) };
    this.assets = { ...(o.assets ?? { USDT: 25_000_000, XAUT: 0 }) };
    this.contacts = o.contacts ? [...o.contacts] : [
      { name: 'bob', ln_address: 'bob@kaleidoswap.com' },
      { name: 'alice', ln_address: 'alice@kaleidoswap.com' },
      { name: 'john', ln_address: 'john.smith@kaleidoswap.com' },
      { name: 'john', ln_address: 'john.doe@kaleidoswap.com' }, // ambiguous on purpose
    ];
    this.utxos = o.utxos ?? 5;
    this.liquid = { ...(o.liquid ?? { 'L-USDT': 100 * 1e8, 'L-BTC': 200_000 }) };
    this.rgbAssets = Object.keys(this.assets).map((ticker) => ({
      asset_id: mockAssetId(ticker),
      ticker,
      name: ticker === 'USDT' ? 'Tether USD' : ticker === 'XAUT' ? 'Tether Gold' : ticker,
      precision: 0,
      schema: 'NIA' as const,
      issued_supply: this.assets[ticker]!,
    }));
  }

  private findAsset(ref: unknown): MockRgbAsset | undefined {
    const q = String(ref ?? '');
    return this.rgbAssets.find((a) => a.asset_id === q || a.ticker.toUpperCase() === q.toUpperCase());
  }

  /** Issue a new RGB asset — mirrors the node: needs a free colored UTXO. */
  issueAsset(args: Record<string, unknown>): MockRgbAsset {
    if (this.utxos < 1) throw new Error('No available colored UTXOs — call rln_create_utxos first.');
    const schema = (['NIA', 'CFA', 'UDA'].includes(String(args.schema)) ? args.schema : 'NIA') as MockRgbAsset['schema'];
    const ticker = String(args.ticker ?? '').toUpperCase();
    if (!/^[A-Z0-9]{1,8}$/.test(ticker)) throw new Error('ticker must be 1-8 uppercase letters/digits.');
    if (this.findAsset(ticker)) throw new Error(`An asset with ticker ${ticker} already exists.`);
    const supply = schema === 'UDA' ? 1 : Number(args.amount);
    if (!(supply > 0)) throw new Error('amount must be positive.');
    const asset: MockRgbAsset = {
      asset_id: mockAssetId(ticker),
      ticker,
      name: String(args.name ?? ticker),
      precision: Number(args.precision ?? 0),
      schema,
      issued_supply: supply,
    };
    this.utxos -= 1;
    this.rgbAssets.push(asset);
    this.assets[ticker] = supply;
    this.transfers.push({ idx: this.transfers.length + 1, asset_id: asset.asset_id, kind: 'Issuance', status: 'Settled', amount: supply });
    this.sends.push({ tool: 'rln_issue_asset', to: 'self', asset: ticker, amount: supply });
    return asset;
  }

  totalSats(): number {
    return this.balances.spark + this.balances.rln + this.balances.arkade;
  }
  /** Back to the constructor state: balances, contacts, UTXOs, issued assets, history. */
  reset(): void {
    Object.assign(this, new MockWallet(this.opts));
  }

  private send(tool: string, rec: { to: string; amount_sats?: number; asset?: string; amount?: number }) {
    if (this.failRoute) throw new Error('No route to destination.');
    if (rec.amount_sats != null && rec.amount_sats > this.totalSats()) {
      throw new Error(`Insufficient funds: have ${this.totalSats()} sats, need ${rec.amount_sats}.`);
    }
    this.sends.push({ tool, ...rec });
    return { status: 'SUCCESS', payment_hash: 'mock' + this.sends.length };
  }

  handlers(): Record<string, WalletHandler> {
    return {
      get_balances: async () => ({
        total_sats: this.totalSats(),
        layers: [
          { layer: 'spark', btc_sats: this.balances.spark, assets: [] },
          { layer: 'rln', btc_sats: this.balances.rln, assets: Object.entries(this.assets).filter(([, v]) => v > 0).map(([ticker, amount]) => ({ ticker, amount })) },
          { layer: 'arkade', btc_sats: this.balances.arkade, assets: [] },
        ],
      }),
      spark_get_balance: async () => ({ btc_sats: this.balances.spark }),
      rln_get_balances: async () => ({ btc_sats: this.balances.rln, assets: this.assets }),
      arkade_get_balance: async () => ({ btc_sats: this.balances.arkade }),
      spark_get_address: async () => ({ address: 'bc1qspark0mockreceiveaddr' }),
      arkade_get_address: async () => ({ address: 'ark1q0mockreceiveaddr' }),
      get_price: async ({ fiat }) => ({ asset: 'BTC', price_usd: this.priceUsd, fiat: (fiat as string) ?? 'USD' }),
      fiat_to_sats: async ({ amount }) => ({ sats: Math.round((Number(amount) / this.priceUsd) * 1e8) }),
      resolve_contact: async ({ name }) => {
        const q = String(name).toLowerCase();
        const matches = this.contacts.filter((c) => c.name.toLowerCase() === q);
        if (matches.length === 0) throw new Error(`No contact named "${name}".`);
        if (matches.length > 1) throw new Error(`Ambiguous: ${matches.length} contacts named "${name}" — ask the user which one.`);
        return matches[0]!;
      },
      rln_create_ln_invoice: async ({ amount_sats }) => ({ invoice: `lnbcmock${amount_sats ?? ''}` }),
      rln_create_rgb_invoice: async ({ asset, amount }) => ({ invoice: 'rgb:mockinvoice', asset, amount }),
      send_payment: async ({ to, amount_sats }) => this.send('send_payment', { to: String(to), amount_sats: amount_sats != null ? Number(amount_sats) : undefined }),
      rln_pay_invoice: async ({ invoice }) => this.send('rln_pay_invoice', { to: String(invoice) }),
      rln_send_asset: async ({ asset, amount, to }) => {
        const a = String(asset);
        if ((this.assets[a] ?? 0) < Number(amount)) throw new Error(`Insufficient ${a} balance.`);
        const res = this.send('rln_send_asset', { to: String(to), asset: a, amount: Number(amount) });
        const found = this.findAsset(a);
        if (found) this.transfers.push({ idx: this.transfers.length + 1, asset_id: found.asset_id, kind: 'Send', status: 'Settled', amount: Number(amount) });
        return res;
      },
      rln_list_assets: async () => ({
        assets: this.rgbAssets.map((a) => ({ ...a, balance: { spendable: this.assets[a.ticker] ?? 0 } })),
      }),
      rln_list_transfers: async ({ asset_id, asset }) => {
        const ref = asset_id ?? asset;
        const found = this.findAsset(ref);
        if (!found) throw new Error(`Unknown asset "${String(ref)}".`);
        return { transfers: this.transfers.filter((x) => x.asset_id === found.asset_id) };
      },
      rln_create_utxos: async ({ num }) => {
        const n = Number(num ?? 5);
        this.utxos += n;
        this.sends.push({ tool: 'rln_create_utxos', to: 'self', amount: n });
        return { created: true, num: n, free_utxos: this.utxos };
      },
      rln_issue_asset: async (args) => {
        const a = this.issueAsset(args);
        return { issued: true, asset_id: a.asset_id, ticker: a.ticker, name: a.name, schema: a.schema, issued_supply: a.issued_supply };
      },
      get_swap_quote: async ({ from_asset, to_asset, amount }) => ({
        quote_id: 'quote-mock',
        from_asset,
        to_asset,
        amount: Number(amount),
        // toy rate: 1 USDT ≈ 1538 sats at $65k; otherwise echo.
        receive_amount: String(from_asset).toUpperCase() === 'USDT' ? Math.round(Number(amount) * (1e8 / this.priceUsd)) : Number(amount),
      }),
      execute_swap: async ({ from_asset, to_asset, amount }) => {
        this.sends.push({ tool: 'execute_swap', to: `${from_asset}->${to_asset}`, amount: Number(amount) });
        return { status: 'SUCCESS', swap_id: 'swap' + this.sends.length };
      },
    };
  }

  /**
   * The KaleidoSwap /v2 submarine contract against a toy maker: 0.5% fee, the
   * invoice amount read from its BOLT11 human-readable part, L-USDT at `priceUsd`.
   */
  submarineHandlers(): Record<string, SubmarineHandler> {
    return {
      kaleidoswap_submarine_pairs: async () => ({
        pairs: [
          { from: 'L-USDT', to: 'BTC', fees: { percentage: 0.5 }, limits: { minimal: 10 * 1e8, maximal: 1_000 * 1e8 } },
          { from: 'L-BTC', to: 'BTC', fees: { percentage: 0.5 }, limits: { minimal: 10_000, maximal: 1_000_000 } },
        ],
      }),
      kaleidoswap_submarine_create: async ({ invoice, from_asset }) => {
        const from = (from_asset ?? 'L-USDT') as 'L-USDT' | 'L-BTC';
        if (from !== 'L-USDT' && from !== 'L-BTC') throw new Error(`Unsupported from_asset "${String(from_asset)}".`);
        const sats = bolt11Sats(String(invoice));
        if (sats == null) throw new Error('invalid_invoice: the invoice must be BOLT11 with an amount.');
        const withFee = sats * 1.005;
        const expected = Math.ceil(from === 'L-USDT' ? (withFee / 1e8) * this.priceUsd * 1e8 : withFee);
        const id = `sub${Object.keys(this.submarineSwaps).length + 1}`;
        this.submarineSwaps[id] = { from, invoice: String(invoice), expected, funded: false };
        return { swap_id: id, from_asset: from, expected_amount: String(expected), lockup_address: `tlq1qmock${id}` };
      },
      kaleidoswap_submarine_fund: async ({ swap_id }) => {
        const swap = this.submarineSwaps[String(swap_id)];
        if (!swap) throw new Error(`No submarine swap "${String(swap_id)}" was created by this server.`);
        if (swap.funded) throw new Error(`Swap ${String(swap_id)} is already funded.`);
        if (this.liquid[swap.from] < swap.expected) throw new Error(`Insufficient ${swap.from} balance.`);
        this.liquid[swap.from] -= swap.expected;
        swap.funded = true;
        this.sends.push({ tool: 'kaleidoswap_submarine_fund', to: swap.invoice, asset: swap.from, amount: swap.expected });
        return { funded: true, swap_id, asset: swap.from, amount: String(swap.expected), txid: `mocktx${String(swap_id)}` };
      },
      kaleidoswap_submarine_status: async ({ swap_id }) => {
        const swap = this.submarineSwaps[String(swap_id)];
        if (!swap) throw new Error(`invalid_swap_id: "${String(swap_id)}" is not a swap id`);
        const status = swap.funded ? 'transaction.claimed' : 'swap.created';
        return { swap_id, status, done: swap.funded, failed: false, funded: swap.funded };
      },
    };
  }

  /** Bind the contract tools to this wallet (optionally overriding some — e.g. to inject). */
  registry(overrides?: Partial<Record<string, WalletHandler>>): ToolRegistry {
    const h = { ...this.handlers(), ...(overrides ?? {}) } as Record<string, WalletHandler>;
    const sub = { ...this.submarineHandlers(), ...(overrides ?? {}) } as Record<string, SubmarineHandler>;
    return new ToolRegistry([
      bindWalletTools(h, { layers: ['spark', 'rln', 'arkade', 'core'], allowMissing: true }),
      bindSubmarineTools(sub, { allowMissing: true }),
    ]);
  }
}

/** Deterministic fake RGB contract id per ticker (stable across runs). */
function mockAssetId(ticker: string): string {
  let h = 0;
  for (const c of ticker) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `rgb:mock-${ticker.toLowerCase()}-${h.toString(36)}`;
}

/** Amount in sats from a BOLT11 human-readable part ("lntbs10u…" → 1000), or null. */
function bolt11Sats(invoice: string): number | null {
  const m = invoice.toLowerCase().match(/^ln(?:bcrt|tbs|bc|tb)(\d+)([munp])?1/);
  if (!m) return null;
  const n = Number(m[1]);
  const mult = { m: 1e5, u: 100, n: 0.1, p: 0.0001 }[m[2] ?? ''] ?? 1e8;
  const sats = n * mult;
  return sats >= 1 ? Math.round(sats) : null;
}
