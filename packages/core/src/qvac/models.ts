/**
 * Recommended local models. Plain data (no SDK import): `qvacConstant` is the
 * name of the matching @qvac/sdk registry export (present since @qvac/sdk
 * 0.13.1), `hfRepo`/`hfFile` the same GGUF on Hugging Face for hosts that
 * download directly. Sizes are the exact file sizes.
 */

export interface RecommendedModel {
  id: string;
  family: string;
  displayName: string;
  /** Name of the @qvac/sdk model constant, e.g. `QWEN3_5_4B_MULTIMODAL_Q4_K_M`. */
  qvacConstant: string;
  quant: string;
  sizeBytes: number;
  hfRepo: string;
  hfFile: string;
  /** Rough RAM needed to run it with the agent's context window. */
  ramHintGb: number;
  notes: string;
}

export const QWEN35_MODELS: readonly RecommendedModel[] = [
  {
    id: 'qwen3.5-0.8b-q4_k_m',
    family: 'qwen3.5',
    displayName: 'Qwen 3.5 · 0.8B',
    qvacConstant: 'QWEN3_5_0_8B_MULTIMODAL_Q4_K_M',
    quant: 'Q4_K_M',
    sizeBytes: 532_517_120,
    hfRepo: 'unsloth/Qwen3.5-0.8B-GGUF',
    hfFile: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    ramHintGb: 1.5,
    notes: 'Smoke-test model. Fine for chat and single read-only tool calls; unreliable on multi-argument wallet actions.',
  },
  {
    id: 'qwen3.5-2b-q4_k_m',
    family: 'qwen3.5',
    displayName: 'Qwen 3.5 · 2B',
    qvacConstant: 'QWEN3_5_2B_MULTIMODAL_Q4_K_M',
    quant: 'Q4_K_M',
    sizeBytes: 1_280_835_840,
    hfRepo: 'unsloth/Qwen3.5-2B-GGUF',
    hfFile: 'Qwen3.5-2B-Q4_K_M.gguf',
    ramHintGb: 3,
    notes: 'Phones and low-RAM laptops. Handles simple tool calls; double-check readbacks on spends.',
  },
  {
    id: 'qwen3.5-4b-q4_k_m',
    family: 'qwen3.5',
    displayName: 'Qwen 3.5 · 4B',
    qvacConstant: 'QWEN3_5_4B_MULTIMODAL_Q4_K_M',
    quant: 'Q4_K_M',
    sizeBytes: 2_740_937_888,
    hfRepo: 'unsloth/Qwen3.5-4B-GGUF',
    hfFile: 'Qwen3.5-4B-Q4_K_M.gguf',
    ramHintGb: 5,
    notes: 'Recommended default for desktop. Smallest model that fills multi-argument RGB tool calls reliably in our tests.',
  },
  {
    id: 'qwen3.5-9b-q4_k_m',
    family: 'qwen3.5',
    displayName: 'Qwen 3.5 · 9B',
    qvacConstant: 'QWEN3_5_9B_MULTIMODAL_Q4_K_M',
    quant: 'Q4_K_M',
    sizeBytes: 5_680_522_464,
    hfRepo: 'unsloth/Qwen3.5-9B-GGUF',
    hfFile: 'Qwen3.5-9B-Q4_K_M.gguf',
    ramHintGb: 9,
    notes: 'Stronger multi-step planning; needs 16 GB of RAM. Slower per token than 4B.',
  },
  {
    id: 'qwen3.6-35b-a3b-q4_k_m',
    family: 'qwen3.6',
    displayName: 'Qwen 3.6 · 35B-A3B (MoE)',
    qvacConstant: 'QWEN3_6_35B_A3B_MULTIMODAL_Q4_K_M',
    quant: 'UD-Q4_K_M',
    sizeBytes: 22_134_528_992,
    hfRepo: 'unsloth/Qwen3.6-35B-A3B-GGUF',
    hfFile: 'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf',
    ramHintGb: 26,
    notes: 'Big machines only (32 GB+). MoE with ~3B active parameters: best quality, 22 GB download.',
  },
];

/** Default model for desktop hosts (the provider sidecar, CLI, examples). */
export const DEFAULT_MODEL_ID = 'qwen3.5-4b-q4_k_m';
/** Default model for phones and other small devices. */
export const DEFAULT_SMALL_DEVICE_MODEL_ID = 'qwen3.5-2b-q4_k_m';

export function getRecommendedModel(id: string): RecommendedModel | undefined {
  return QWEN35_MODELS.find((m) => m.id === id);
}

/** @qvac/sdk constant name of the desktop default, e.g. for `sdk[DEFAULT_QVAC_MODEL]`. */
export const DEFAULT_QVAC_MODEL = getRecommendedModel(DEFAULT_MODEL_ID)!.qvacConstant;
/** @qvac/sdk constant name of the small-device default. */
export const DEFAULT_SMALL_DEVICE_QVAC_MODEL = getRecommendedModel(DEFAULT_SMALL_DEVICE_MODEL_ID)!.qvacConstant;
