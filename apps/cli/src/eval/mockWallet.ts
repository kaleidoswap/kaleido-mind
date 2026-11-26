/**
 * The eval's stateful mock wallet now lives in core so hosts can use it too
 * (`@kaleidoswap/mind/testing`). Re-exported here for the existing eval imports.
 */

export { MockWallet } from '@kaleidoswap/mind/testing';
export type { MockWalletOptions, MockContact, SendRecord } from '@kaleidoswap/mind/testing';
