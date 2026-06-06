/**
 * Model catalog for the CLI — chat (LLM) + embedding models, downloaded as
 * GGUF from Hugging Face into the shared QVAC model dir (~/.kaleido/models) and
 * loaded by the QVAC SDK. Probe-verified repos (mirror of apps/provider).
 */

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

export const CATALOG: CatalogModel[] = [
  {
    id: 'qwen3-0.6b',
    kind: 'llm',
    displayName: 'Qwen 3 · 0.6B',
    params: '0.6B',
    quant: 'Q4_K_M',
    sizeBytes: 420_000_000,
    ramHintGb: 1,
    hfRepo: 'unsloth/Qwen3-0.6B-GGUF',
    hfFile: 'Qwen3-0.6B-Q4_K_M.gguf',
    notes: 'Tiny. Great for Pi / smoke tests. Tool selection works; weak params.',
  },
  {
    id: 'qwen3-1.7b',
    kind: 'llm',
    displayName: 'Qwen 3 · 1.7B',
    params: '1.7B',
    quant: 'Q4_K_M',
    sizeBytes: 1_100_000_000,
    ramHintGb: 2,
    hfRepo: 'unsloth/Qwen3-1.7B-GGUF',
    hfFile: 'Qwen3-1.7B-Q4_K_M.gguf',
    notes: 'Fast, usable agent. Mobile sweet spot.',
  },
  {
    id: 'qwen3-4b',
    kind: 'llm',
    displayName: 'Qwen 3 · 4B',
    params: '4B',
    quant: 'Q4_K_M',
    sizeBytes: 2_400_000_000,
    ramHintGb: 4,
    hfRepo: 'unsloth/Qwen3-4B-GGUF',
    hfFile: 'Qwen3-4B-Q4_K_M.gguf',
    notes: 'Solid function calling. Good default on a laptop.',
  },
  {
    id: 'qwen3-8b',
    kind: 'llm',
    displayName: 'Qwen 3 · 8B',
    params: '8B',
    quant: 'Q4_K_M',
    sizeBytes: 5_000_000_000,
    ramHintGb: 7,
    hfRepo: 'unsloth/Qwen3-8B-GGUF',
    hfFile: 'Qwen3-8B-Q4_K_M.gguf',
    notes: 'Daily-driver desktop quality.',
  },
  {
    id: 'qwen3-14b',
    kind: 'llm',
    displayName: 'Qwen 3 · 14B',
    params: '14B',
    quant: 'Q4_K_M',
    sizeBytes: 9_000_000_000,
    ramHintGb: 12,
    hfRepo: 'unsloth/Qwen3-14B-GGUF',
    hfFile: 'Qwen3-14B-Q4_K_M.gguf',
    notes: 'Stronger reasoning. Needs a roomy machine.',
  },
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
    sizeBytes: 670_000_000,
    ramHintGb: 2,
    hfRepo: 'Alibaba-NLP/gte-large-en-v1.5',
    hfFile: 'gte-large_fp16.gguf',
    notes: '1024-dim embeddings for RAG. QVAC GTE_LARGE_FP16.',
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
  const pick = (id: string) => getModel(id)!;
  if (gb < 3) return pick('qwen3-0.6b');
  if (gb < 8) return pick('qwen3-1.7b');
  if (gb < 16) return pick('qwen3-4b');
  return pick('qwen3-8b');
}
