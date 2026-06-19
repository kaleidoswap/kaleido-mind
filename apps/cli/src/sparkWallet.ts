/**
 * CLI Spark wallet — local-first SparkWallet on regtest (or any network).
 *
 * Mnemonic persistence:
 *   ~/.kaleido/spark.mnemonic     (24-word BIP39, mode 0600)
 *
 * On first run, generates a fresh mnemonic + writes it. Tells the user where
 * it lives so they can back it up. The wallet is initialized with the SDK's
 * `network: 'REGTEST'` (or whatever KALEIDO_SPARK_NETWORK names).
 *
 * Exports:
 *   - getSparkWallet(): lazy singleton — boots once, returns the wallet handle
 *   - buildSparkWalletToolSource(): binds the canonical spark_* contract tools
 *     (spark_get_balance, spark_get_address, spark_create_invoice,
 *     spark_pay_invoice) to live SDK calls. Used by chat.ts.
 *
 * No mocks. If the SDK can't load (peer dep mismatch, no network), the binder
 * throws on first use — chat.ts catches and falls back to the mock wallet.
 */

import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { bindWalletTools, type WalletHandler, type WalletLayer } from '@kaleidorg/mind';
import type { InProcessToolSource } from '@kaleidorg/mind';

const MNEMONIC_PATH = process.env.KALEIDO_SPARK_MNEMONIC_PATH
  ?? join(homedir(), '.kaleido', 'spark.mnemonic');

/** Spark SDK network names — uppercase. */
type SparkNetwork = 'MAINNET' | 'TESTNET' | 'REGTEST' | 'SIGNET' | 'LOCAL';

function resolveNetwork(): SparkNetwork {
  const v = (process.env.KALEIDO_SPARK_NETWORK ?? 'REGTEST').toUpperCase();
  if (v === 'MAINNET' || v === 'TESTNET' || v === 'REGTEST' || v === 'SIGNET' || v === 'LOCAL') return v;
  return 'REGTEST';
}

async function loadOrCreateMnemonic(): Promise<{ mnemonic: string; created: boolean }> {
  try {
    const raw = await readFile(MNEMONIC_PATH, 'utf8');
    const mnemonic = raw.trim();
    if (mnemonic.split(/\s+/).length >= 12) return { mnemonic, created: false };
  } catch { /* fall through */ }

  // Generate fresh 24-word BIP39 mnemonic.
  const bip39 = await import('@scure/bip39');
  const { wordlist } = await import('@scure/bip39/wordlists/english');
  const mnemonic = bip39.generateMnemonic(wordlist, 256);

  await mkdir(dirname(MNEMONIC_PATH), { recursive: true });
  await writeFile(MNEMONIC_PATH, mnemonic + '\n');
  try { await chmod(MNEMONIC_PATH, 0o600); } catch { /* best-effort */ }
  return { mnemonic, created: true };
}

interface SparkWalletInstance {
  wallet: any;
  network: SparkNetwork;
  mnemonicCreated: boolean;
}

let _walletPromise: Promise<SparkWalletInstance> | null = null;

/**
 * Lazy singleton — returns the initialized SparkWallet. Subsequent calls
 * return the same instance. Throws if SDK isn't reachable.
 */
export function getSparkWallet(): Promise<SparkWalletInstance> {
  if (_walletPromise) return _walletPromise;
  _walletPromise = (async () => {
    const network = resolveNetwork();
    const { mnemonic, created } = await loadOrCreateMnemonic();
    const sdk = await import('@buildonspark/spark-sdk');
    const SparkWallet: any = (sdk as any).SparkWallet;
    if (!SparkWallet) throw new Error('@buildonspark/spark-sdk: SparkWallet not exported');
    const { wallet } = await SparkWallet.initialize({
      mnemonicOrSeed: mnemonic,
      options: { network },
    });
    return { wallet, network, mnemonicCreated: created };
  })();
  return _walletPromise.catch((e) => {
    // Reset so a retry can re-attempt after the user fixes the underlying issue.
    _walletPromise = null;
    throw e;
  });
}

/** Normalize whatever shape an adapter's createInvoice returns to { invoice }. */
function normInvoice(r: any): Record<string, unknown> {
  if (typeof r === 'string') return { invoice: r };
  const invoice = r?.invoice ?? r?.encodedInvoice ?? r?.paymentRequest ?? r?.bolt11 ?? r?.pr ?? r;
  return typeof invoice === 'string' ? { invoice, ...(typeof r === 'object' ? r : {}) } : (r && typeof r === 'object' ? r : { invoice: r });
}

/**
 * Build the InProcessToolSource for spark_* contract tools backed by the
 * live SparkWallet. Boots the wallet on first call. With `KALEIDO_VERBOSE=1`
 * the host prints which network and a redacted public key on init.
 */
export async function buildSparkWalletToolSource(opts: { log?: (m: string) => void } = {}): Promise<InProcessToolSource> {
  const { wallet, network, mnemonicCreated } = await getSparkWallet();
  const log = opts.log ?? (() => {});

  let pubkey: string | undefined;
  try { pubkey = await wallet.getIdentityPublicKey?.(); } catch { /* ignore */ }
  log(`spark wallet ready · network=${network}${pubkey ? ` · pubkey=${pubkey.slice(0, 10)}…` : ''}${mnemonicCreated ? ' · (new mnemonic saved to ' + MNEMONIC_PATH + ')' : ''}`);

  const handlers: Record<string, WalletHandler> = {
    spark_get_balance: async () => {
      const b: any = await wallet.getBalance();
      // SDK returns { balance: bigint, tokenBalances: Map<string,
      // TokenBalance> }. Both need to be surfaced — Spark holds BTC AND
      // Spark-native tokens (USDB, etc.). Dropping tokenBalances made every
      // token balance invisible to the model.
      const total = typeof b?.balance === 'bigint' ? Number(b.balance) : Number(b?.balance ?? b?.sats ?? 0);
      const tokens: Array<{
        address: string;
        balance: string;
        available_to_send?: string;
        symbol?: string;
        name?: string;
        decimals?: number;
      }> = [];
      const tb = b?.tokenBalances;
      if (tb && typeof tb.forEach === 'function') {
        tb.forEach((v: any, k: string) => {
          tokens.push({
            address: k,
            balance: typeof v?.balance === 'bigint' ? v.balance.toString() : String(v?.balance ?? '0'),
            available_to_send:
              typeof v?.availableToSendBalance === 'bigint'
                ? v.availableToSendBalance.toString()
                : v?.availableToSendBalance != null ? String(v.availableToSendBalance) : undefined,
            symbol: v?.tokenInfo?.tokenSymbol,
            name: v?.tokenInfo?.tokenName,
            decimals: v?.tokenInfo?.tokenDecimals,
          });
        });
      }
      // `connected: true` tells the model the wallet is reachable. The
      // skill text relies on this to disambiguate "0 sats but live" from
      // "tool errored out". The handler ONLY returns this object on
      // success — adapter errors throw, surfaced as Error.message.
      return { total, tokens, layer: 'spark', network, connected: true };
    },
    spark_get_address: async () => {
      const address = await wallet.getSparkAddress();
      return {
        address,
        kind: 'spark_identity',
        layer: 'spark',
        network,
        connected: true,
        note: 'Off-chain Spark identity (sparkrt1…/spark1…). For receiving Spark-to-Spark transfers. NOT a Bitcoin on-chain address.',
      };
    },
    spark_get_onchain_address: async () => {
      const address = await wallet.getStaticDepositAddress();
      return {
        address,
        kind: 'onchain_deposit',
        layer: 'spark',
        network,
        connected: true,
        note: 'Real Bitcoin on-chain address. Send L1 BTC here to deposit into Spark — the deposit becomes claimable once it confirms.',
      };
    },
    spark_create_invoice: async ({ amount_sats }) => {
      const r = await wallet.createLightningInvoice({
        amountSats: amount_sats != null ? Number(amount_sats) : undefined,
        memo: 'kaleido-mind',
      });
      return normInvoice(r);
    },
    spark_pay_invoice: async ({ invoice, amount_sats }) => {
      const r: any = await wallet.payLightningInvoice({
        invoice: String(invoice),
        maxFeeSats: 10, // small regtest default; real users can override later
        ...(amount_sats != null ? { amountSatsToSend: Number(amount_sats) } : {}),
      });
      // Normalize what the SDK returns (LightningSendRequest | WalletTransfer)
      // to a JSON-safe summary the model can surface.
      return {
        ok: true,
        transfer_id: r?.id ?? r?.requestId ?? r?.transferSparkId,
        payment_hash: r?.paymentHash,
        fee_sats: typeof r?.feeSats === 'bigint' ? Number(r.feeSats) : r?.feeSats,
        status: r?.status,
      };
    },
  };

  const layers: WalletLayer[] = ['spark', 'core'];
  return bindWalletTools(handlers, { layers, includeCore: false, allowMissing: true, id: 'wallet-spark' });
}

/** Re-export for chat.ts to log the path. */
export const SPARK_MNEMONIC_PATH = MNEMONIC_PATH;
