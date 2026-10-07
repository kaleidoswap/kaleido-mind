/** Flashnet (Spark-native AMM): tool contract and swap recipe. */
export {
  FLASHNET_TOOLS,
  FLASHNET_SPEND_TOOLS,
  isFlashnetSpendTool,
  getFlashnetTool,
  bindFlashnetTools,
} from './contract.js';
export type {
  FlashnetToolDef,
  FlashnetHandler,
  BindFlashnetOptions,
} from './contract.js';
export { flashnetSwapRecipe } from '../recipe/flashnet-swap.js';
