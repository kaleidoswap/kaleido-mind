/**
 * The eval's stateful mock wallet now lives in core so hosts can use it too
 * (`@kaleidorg/mind/testing`). Re-exported here for the existing eval imports.
 */

export { MockWallet } from '@kaleidorg/mind/testing';
export type { MockWalletOptions, MockContact, SendRecord } from '@kaleidorg/mind/testing';
