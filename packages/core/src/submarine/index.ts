/** KaleidoSwap /v2 submarine swaps (pay Lightning from Liquid): tool contract and recipe. */
export {
  SUBMARINE_TOOLS,
  SUBMARINE_SPEND_TOOLS,
  SUBMARINE_FROM_ASSETS,
  isSubmarineSpendTool,
  getSubmarineTool,
  formatSubmarineAmount,
  bindSubmarineTools,
} from './contract.js';
export type {
  SubmarineToolDef,
  SubmarineFromAsset,
  SubmarineHandler,
  BindSubmarineOptions,
} from './contract.js';
export { submarinePayRecipe, extractSubmarinePay } from '../recipe/submarine-pay.js';
