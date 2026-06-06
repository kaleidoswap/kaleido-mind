/**
 * Bitcoin-copilot knowledge pack — a curated, on-brand corpus to RAG over so an
 * on-device assistant can answer Bitcoin / Lightning / RGB / KaleidoSwap
 * questions privately. Ship it, ingest it with a Retriever, done.
 *
 * Concise + accurate. Extend or replace with your own docs (BOLT specs, RGB
 * docs, app help, FAQs) — the format is just `RagDocument[]`.
 */

import type { RagDocument } from '../rag/types.js';

export const BITCOIN_COPILOT_DOCS: RagDocument[] = [
  {
    id: 'inbound-liquidity',
    text:
      'To RECEIVE Lightning payments you need inbound liquidity — remote balance ' +
      'on a channel pointing at you. Brand-new wallets have none, so they can ' +
      'send but not receive. Get inbound liquidity by buying a channel from an ' +
      'LSP, or by receiving an on-chain deposit and swapping it into a channel.',
    metadata: { topic: 'liquidity' },
  },
  {
    id: 'outbound-liquidity',
    text:
      'Outbound liquidity is your local balance on a channel — what you can ' +
      'spend over Lightning. You get it by funding a channel yourself or being ' +
      'pushed funds. If you can receive but not send, you lack outbound liquidity.',
    metadata: { topic: 'liquidity' },
  },
  {
    id: 'channel-basics',
    text:
      'A Lightning channel is a 2-of-2 multisig funding output shared by two ' +
      'peers. It lets them send instant, low-fee payments off-chain by updating ' +
      'who owns how much, without touching the blockchain until the channel closes.',
    metadata: { topic: 'lightning' },
  },
  {
    id: 'onchain-vs-lightning',
    text:
      'On-chain Bitcoin transactions settle directly on the blockchain: final, ' +
      'but slower and with miner fees. Lightning payments are instant and cheap ' +
      'but require channels with liquidity. Use Lightning for spending, on-chain ' +
      'for settlement and for funding channels.',
    metadata: { topic: 'lightning' },
  },
  {
    id: 'open-channel',
    text:
      'Opening a channel funds a 2-of-2 output on-chain; it confirms in one or ' +
      'more blocks (or is usable immediately with 0-conf if the peer allows). ' +
      'The funder gets outbound liquidity. To get inbound, buy a channel from an ' +
      'LSP instead of opening your own.',
    metadata: { topic: 'channels' },
  },
  {
    id: 'lsp-lsps1',
    text:
      'An LSP (Lightning Service Provider) sells channels. With LSPS1 you place ' +
      'a channel order: choose capacity and how much inbound liquidity you want, ' +
      'pay the fee, and the LSP opens a channel to you — often 0-conf, so you can ' +
      'receive right away. KaleidoSwap acts as an LSP.',
    metadata: { topic: 'channels' },
  },
  {
    id: 'atomic-swap',
    text:
      'An atomic (HTLC) swap exchanges two assets so that either both legs ' +
      'happen or neither does — no counterparty can run off with your funds. ' +
      'KaleidoSwap uses a 5-step HTLC taker flow for trustless swaps.',
    metadata: { topic: 'swaps' },
  },
  {
    id: 'submarine-swap',
    text:
      'A submarine swap moves value between on-chain Bitcoin and Lightning ' +
      'atomically via an HTLC: send on-chain BTC and receive it on Lightning, or ' +
      'vice-versa, with no custodian. Useful to refill inbound/outbound liquidity.',
    metadata: { topic: 'swaps' },
  },
  {
    id: 'rgb-assets',
    text:
      'RGB is a protocol for issuing assets — like USDT and XAUT — on top of ' +
      'Bitcoin and Lightning. Validation is client-side, which keeps it private ' +
      'and scalable. On KaleidoSwap you can hold and swap RGB assets.',
    metadata: { topic: 'rgb' },
  },
  {
    id: 'colored-channels',
    text:
      'A colored channel is a Lightning channel that also carries an RGB asset ' +
      'balance, so you can send/receive USDT or XAUT over Lightning instantly. ' +
      'Buying an asset channel from the LSP gives you inbound capacity for that asset.',
    metadata: { topic: 'rgb' },
  },
  {
    id: 'rgb-invoice',
    text:
      'An RGB invoice requests a specific asset and amount and includes a ' +
      'blinded UTXO so the sender can transfer the asset privately. It differs ' +
      'from a plain Lightning (BOLT11) invoice, which is for BTC.',
    metadata: { topic: 'rgb' },
  },
  {
    id: 'rfq-quote',
    text:
      'Before a swap, KaleidoSwap gives a quote via RFQ (request for quote): the ' +
      'maker prices the pair (e.g. BTC/USDT) and returns the amount you will ' +
      'receive and the fees. Quotes expire — re-quote if you wait.',
    metadata: { topic: 'trading' },
  },
  {
    id: 'maker-taker',
    text:
      'KaleidoSwap is maker-based: a maker provides liquidity and prices, you ' +
      'are the taker who accepts a quote and executes the atomic swap. The maker ' +
      'also runs the LSP that sells channels.',
    metadata: { topic: 'trading' },
  },
  {
    id: 'mpp',
    text:
      'Multi-path payments (MPP) split one Lightning payment across several ' +
      'channels/routes so you can send more than any single channel allows. The ' +
      'parts recombine at the destination atomically.',
    metadata: { topic: 'lightning' },
  },
  {
    id: 'lightning-fees',
    text:
      'Lightning fees are tiny: a base fee plus a proportional fee per hop, paid ' +
      'to routing nodes. They are far smaller than on-chain miner fees, which is ' +
      'why Lightning suits everyday spending.',
    metadata: { topic: 'fees' },
  },
  {
    id: 'zero-conf',
    text:
      '0-conf (zero-confirmation) means a channel is usable before its funding ' +
      'transaction is mined. It relies on trusting the channel partner not to ' +
      'double-spend; LSPs commonly offer it so you can receive instantly.',
    metadata: { topic: 'channels' },
  },
  {
    id: 'seed-backup',
    text:
      'Your seed phrase (12/24 words) controls your funds. Write it down offline ' +
      'and never share or photograph it. A KaleidoSwap node also needs channel ' +
      'state backups: losing them can mean losing funds in open channels.',
    metadata: { topic: 'security' },
  },
  {
    id: 'receiving',
    text:
      'To receive: share a Lightning invoice (BOLT11) or an on-chain address. ' +
      'For Lightning you need inbound liquidity first. For RGB assets, share an ' +
      'RGB invoice. On-chain always works but is slower.',
    metadata: { topic: 'usage' },
  },
  {
    id: 'sending',
    text:
      'To send: pay a Lightning invoice or a Lightning address for BTC, or use ' +
      'an on-chain address. You need outbound liquidity for Lightning. Always ' +
      'check the amount and destination before paying.',
    metadata: { topic: 'usage' },
  },
  {
    id: 'dca',
    text:
      'Dollar-cost averaging (DCA) buys a fixed amount on a schedule to smooth ' +
      'out price swings. KaleidoSwap can automate recurring swaps so you ' +
      'accumulate BTC or an asset over time without timing the market.',
    metadata: { topic: 'trading' },
  },
];
