/** Knowledge packs and corpus adapters for RAG, and the BTC Map merchant tool. */
export { BITCOIN_COPILOT_DOCS } from './bitcoin-copilot.js';
export { walletHistoryToDocuments, contactsToDocuments } from './wallet.js';
export type { WalletTx, Contact } from './wallet.js';
export { merchantsToDocuments } from './merchants.js';
export type { Merchant } from './merchants.js';
export { createBtcMapToolSource } from './btc-map.js';
export type {
  BtcMapToolOptions,
  BtcMapMerchant,
  BtcMapFetch,
  LocationProvider,
  LatLng,
} from './btc-map.js';
