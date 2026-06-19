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
  {
    id: 'spend-vs-receive-capacity',
    text:
      'Two completely different numbers, often confused: your SPEND capacity ' +
      '(outbound, local balance — what you can send right now) and your ' +
      'RECEIVE capacity (inbound, remote balance — what others can pay you ' +
      'without opening a new channel). Knowing local_balance does NOT tell ' +
      'you receive capacity, and vice versa. "How much can I spend?" → local ' +
      'balance. "How much can I receive?" → inbound, derived from channels ' +
      'or bought from an LSP.',
    metadata: { topic: 'liquidity' },
  },
  {
    id: 'nodeinfo-fields',
    text:
      'Common RGB Lightning Node fields and what they actually mean: pubkey ' +
      '(your node identity); num_channels (total channels, including unusable ' +
      'ones); num_usable_channels (subset that can route — what you spend ' +
      'with); local_balance_sat (sats YOU own across all channels — your ' +
      'spend / outbound capacity); pending_outbound_payments_sat (in-flight, ' +
      'temporarily locked); eventual_close_fees_sat (cost if you close every ' +
      'channel now); num_peers (connected peers). local_balance_sat is NOT ' +
      'receive capacity and NOT total channel capacity.',
    metadata: { topic: 'lightning' },
  },
  {
    id: 'channel-two-sided',
    text:
      'Every Lightning channel has TWO balances: your side (local — what you ' +
      'can spend) and the peer\'s side (remote — what they can spend, which ' +
      'is what YOU can receive). Total channel capacity = local + remote and ' +
      'is fixed at open time. Routing a payment moves sats from one side to ' +
      'the other; it does NOT change total capacity. So if you "have 2 ' +
      'channels with 1,000,000 sats total capacity", that does NOT mean you ' +
      'can spend 1M and receive 1M — only the split tells you.',
    metadata: { topic: 'channels' },
  },
  {
    id: 'lsp-info-meaning',
    text:
      'The LSPS1 `get_info` endpoint returns the LSP\'s OFFER (min/max ' +
      'channel size you can buy, fees, accepted payment options). It is NOT ' +
      'your current inbound capacity — it describes what the LSP is willing ' +
      'to sell you. To learn your CURRENT receive capacity, sum the remote ' +
      'balance of your existing channels; to BUY MORE, use kaleidoswap_lsp_get_info and ' +
      'kaleidoswap_lsp_create_order.',
    metadata: { topic: 'channels' },
  },
  {
    id: 'asset-channels',
    text:
      'RGB asset channels (colored channels) carry one specific asset like ' +
      'USDT or XAUT alongside the BTC funding. Asset capacity is SEPARATE per ' +
      'asset — having 100,000 sats spendable in BTC channels does not give ' +
      'you USDT spendable; you need a USDT channel (or buy one via LSPS1). ' +
      'Likewise, USDT inbound and BTC inbound are independent numbers.',
    metadata: { topic: 'rgb' },
  },
  {
    id: 'swap-vs-payment',
    text:
      'Swap and payment are different actions. A SWAP trades one asset for ' +
      'another via the KaleidoSwap maker (quote → init → execute). A PAYMENT ' +
      'moves an existing balance to a recipient over Lightning or on-chain ' +
      '(no maker). "Send 10 USDT to Alice" is a payment; "swap 10 USDT to ' +
      'BTC" is a swap. They use different tools, different fees, and a swap ' +
      'is always between two assets the maker prices.',
    metadata: { topic: 'usage' },
  },
  {
    id: 'asset-channel-prereq',
    text:
      'Why you must buy a channel BEFORE swapping an RGB asset. An RGB ' +
      'Lightning swap moves an asset (USDT, XAUT, …) across a channel that ' +
      'already carries that asset. If you have no USDT channel, the maker ' +
      'cannot pay you USDT over Lightning — there is no rail to push it ' +
      "down. Open a USDT channel from the LSP first (LSPS1 with `asset_id`, " +
      '`lsp_asset_amount`) — the LSP funds the asset on their side, you get ' +
      'inbound USDT capacity, and afterwards a BTC→USDT swap can settle into ' +
      'that channel. Same for XAUT or any other RGB asset. You need ONE ' +
      'channel per asset you want to receive over Lightning.',
    metadata: { topic: 'rgb-channels' },
  },
  {
    id: 'asset-channel-buy',
    text:
      "Buying a channel that already has an asset inside. Use LSPS1 with " +
      "`asset_id` to ask the LSP to open a channel that's pre-funded on the " +
      "LSP side with a specific RGB asset. `lsp_asset_amount` is the asset " +
      "units the LSP commits on their side (your future inbound capacity " +
      "in that asset). `lsp_balance_sat` is the sats the LSP commits for " +
      "fees/anchor; `client_balance_sat` is what you push in sats. Common " +
      "shape: lsp_balance_sat 5_000_000, client_balance_sat 100_000, " +
      "asset_id <USDT id>, lsp_asset_amount 100_000_000 micro-USDT (= 100 " +
      "USDT). Pay the resulting Lightning invoice and the channel opens " +
      "with the asset pre-loaded.",
    metadata: { topic: 'rgb-channels' },
  },
  {
    id: 'asset-channel-with-push',
    text:
      "Receiving an asset balance ON your side at channel open. Beyond the " +
      "LSP-funded asset, you can request the LSP push some asset balance to " +
      "YOUR side during the open via `client_asset_amount`. This costs sats " +
      "(BTC → asset at the maker rate), so the maker requires a fresh " +
      "`rfq_id` from `kaleidoswap_get_quote(BTC → asset)` to lock the " +
      "price. The order then charges the BTC equivalent on top of the " +
      "channel fee. Use when you want spendable asset balance immediately " +
      "(not just inbound capacity).",
    metadata: { topic: 'rgb-channels' },
  },
];
