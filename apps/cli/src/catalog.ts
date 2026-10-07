/**
 * Model catalog for the CLI — chat (LLM) + embedding models, downloaded as
 * GGUF from Hugging Face into the shared QVAC model dir (~/.kaleido/models) and
 * loaded by the QVAC SDK. Probe-verified repos (mirror of apps/provider).
 */

import { QWEN35_MODELS, DEFAULT_MODEL_ID } from '@kaleidorg/mind/qvac';

export type ModelKind = 'llm' | 'embeddings' | 'psy';

export interface CatalogModel {
  id: string;
  kind: ModelKind;
  displayName: string;
  params: string;
  quant: string;
  sizeBytes: number;
  ramHintGb: number;
  hfRepo: string;
  hfFile: string;
  notes: string;
}

/** Short CLI id for a recommended model, e.g. `qwen3.5-4b`. */
const cliId = (id: string) => id.replace(/-q4_k_m$/, '');

const LLM_MODELS: CatalogModel[] = QWEN35_MODELS.map((m) => ({
  id: cliId(m.id),
  kind: 'llm',
  displayName: m.displayName,
  params: m.displayName.split('· ')[1]?.replace(/ \(MoE\)$/, '') ?? '',
  quant: m.quant,
  sizeBytes: m.sizeBytes,
  ramHintGb: m.ramHintGb,
  hfRepo: m.hfRepo,
  hfFile: m.hfFile,
  notes: m.notes,
}));

export const CATALOG: CatalogModel[] = [
  ...LLM_MODELS,
  {
    id: 'medpsy-4b',
    kind: 'psy',
    displayName: 'MedPsy · 4B',
    params: '4B',
    quant: 'Q4_K_M',
    sizeBytes: 2_500_000_000,
    ramHintGb: 4,
    hfRepo: 'tetherto/qvac-models',
    hfFile: 'medpsy-4b-q4_k_m-imat.gguf',
    notes: "Tether's medical/psych reasoning model. Psy track. (Pre-provisioned.)",
  },
  {
    id: 'gte-large',
    kind: 'embeddings',
    displayName: 'GTE-Large (embeddings)',
    params: '335M',
    quant: 'FP16',
    sizeBytes: 669_603_712,
    ramHintGb: 2,
    hfRepo: 'ChristianAzinn/gte-large-gguf',
    hfFile: 'gte-large_fp16.gguf',
    notes: '1024-dim embeddings for RAG. Same FP16 GGUF QVAC serves — loads on the fork.',
  },
];

export function getModel(id: string): CatalogModel | undefined {
  return CATALOG.find((m) => m.id === id);
}

export function hfUrl(m: CatalogModel): string {
  return `https://huggingface.co/${m.hfRepo}/resolve/main/${m.hfFile}`;
}

/** Recommend a chat model for the device RAM (conservative — favour smaller). */
export function recommendChatModel(totalMemBytes: number): CatalogModel {
  const gb = totalMemBytes / 1024 ** 3;
  const pick = (id: string) => getModel(cliId(id))!;
  return gb < 3 ? pick('qwen3.5-0.8b-q4_k_m') : pick(DEFAULT_MODEL_ID);
}
