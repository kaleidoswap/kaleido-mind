/** CLI config — persisted at ~/.kaleido/mind/config.json. */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export interface CliConfig {
  /** Selected chat model id (catalog). */
  modelId?: string;
  /** RAG enabled (downloads + uses an embedding model). */
  rag: boolean;
  /** Optional path to a kaleido-mcp entry to attach its tools. */
  mcpEntry?: string;
  /** Set once the setup wizard has run. */
  setupDone: boolean;
}

export const KALEIDO_HOME = join(homedir(), '.kaleido');
export const MODELS_DIR = join(KALEIDO_HOME, 'models');
export const MIND_DIR = join(KALEIDO_HOME, 'mind');
export const CONFIG_PATH = join(MIND_DIR, 'config.json');
export const MEMORY_PATH = join(MIND_DIR, 'memory.json');

const DEFAULT: CliConfig = { rag: false, setupDone: false };

export async function loadConfig(): Promise<CliConfig> {
  try {
    return { ...DEFAULT, ...JSON.parse(await readFile(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT };
  }
}

export async function saveConfig(cfg: CliConfig): Promise<void> {
  await mkdir(MIND_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
