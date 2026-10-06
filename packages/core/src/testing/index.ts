/**
 * @kaleidorg/mind/testing — build and demo an agent with no node, no funds and
 * no model: a stateful mock wallet bound to the canonical contract, plus a
 * scripted provider.
 *
 *   import { MockWallet, scriptedProvider } from '@kaleidorg/mind/testing';
 *   const wallet = new MockWallet();
 *   const funnel = new Funnel({ provider: scriptedProvider(), tools: wallet.registry(), … });
 */

export { MockWallet } from './mock-wallet.js';
export type { MockWalletOptions, MockContact, MockRgbAsset, MockTransfer, SendRecord } from './mock-wallet.js';
export { scriptedProvider } from './scripted-provider.js';
export type { ScriptedTurn } from './scripted-provider.js';
