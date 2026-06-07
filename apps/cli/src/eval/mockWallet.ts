/**
 * A stateful mock wallet for realistic eval — balances per layer, contacts
 * (incl. ambiguous + injectable), a price, validation (insufficient funds, no
 * route, unknown contact), and a record of what actually got "sent". The
 * canonical contract tools bind to it, so the agent sees real schemas and real
 * failure modes — not trivial canned stubs.
 */

import { bindWalletTools, ToolRegistry, type WalletHandler } from '@kaleidorg/mind';

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
}

export class MockWallet {
  priceUsd: number;
  failRoute: boolean;
  balances: { spark: number; rln: number; arkade: number };
  assets: Record<string, number>;
  contacts: MockContact[];
  sends: SendRecord[] = [];

  constructor(o: MockWalletOptions = {}) {
    this.priceUsd = o.priceUsd ?? 65_000;
    this.failRoute = o.failRoute ?? false;
    this.balances = o.balances ?? { spark: 500_000, rln: 300_000, arkade: 200_000 };
    this.assets = o.assets ?? { USDT: 25_000_000, XAUT: 0 };
    this.contacts = o.contacts ?? [
      { name: 'bob', ln_address: 'bob@kaleidoswap.com' },
      { name: 'alice', ln_address: 'alice@kaleidoswap.com' },
      { name: 'john', ln_address: 'john.smith@kaleidoswap.com' },
      { name: 'john', ln_address: 'john.doe@kaleidoswap.com' }, // ambiguous on purpose
    ];
  }

  totalSats(): number {
    return this.balances.spark + this.balances.rln + this.balances.arkade;
  }
  reset(): void {
    this.sends = [];
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
        return this.send('rln_send_asset', { to: String(to), asset: a, amount: Number(amount) });
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

  /** Bind the contract tools to this wallet (optionally overriding some — e.g. to inject). */
  registry(overrides?: Partial<Record<string, WalletHandler>>): ToolRegistry {
    const h = { ...this.handlers(), ...(overrides ?? {}) } as Record<string, WalletHandler>;
    return new ToolRegistry([bindWalletTools(h, { layers: ['spark', 'rln', 'arkade', 'core'], allowMissing: true })]);
  }
}
