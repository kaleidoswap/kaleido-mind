/** Model store — scan installed, download (HF stream + live progress), delete. */

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MODELS_DIR } from './config.js';
import { CATALOG, getModel, hfUrl, type CatalogModel } from './catalog.js';
import { bar, bytes, c, rewriteLine } from './ui.js';

export interface InstalledModel {
  id: string;
  path: string;
  sizeBytes: number;
}

/** Local path a model lives at once downloaded. */
export function modelPath(m: CatalogModel): string {
  return join(MODELS_DIR, m.hfFile);
}

/** Catalog models present on disk (≥99% of expected size). */
export async function listInstalled(): Promise<InstalledModel[]> {
  let files: string[] = [];
  try {
    files = await readdir(MODELS_DIR);
  } catch {
    return [];
  }
  const out: InstalledModel[] = [];
  for (const m of CATALOG) {
    if (!files.includes(m.hfFile)) continue;
    try {
      const s = await stat(join(MODELS_DIR, m.hfFile));
      if (s.size >= m.sizeBytes * 0.95) out.push({ id: m.id, path: join(MODELS_DIR, m.hfFile), sizeBytes: s.size });
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function isInstalled(id: string): Promise<boolean> {
  return (await listInstalled()).some((m) => m.id === id);
}

/** Download a catalog model into the model dir with a live progress bar. */
export async function pullModel(id: string): Promise<string> {
  const m = getModel(id);
  if (!m) throw new Error(`unknown model: ${id}`);
  await mkdir(MODELS_DIR, { recursive: true });
  const finalPath = modelPath(m);
  const tmp = `${finalPath}.partial`;

  if (await isInstalled(id)) {
    console.log(c.green(`✓ ${m.displayName} already installed`));
    return finalPath;
  }

  const url = hfUrl(m);
  console.log(`${c.violet('⤓')} ${c.bold(m.displayName)} ${c.dim(`(${bytes(m.sizeBytes)})`)}`);
  console.log(c.dim(`  ${url}`));

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length') || '0') || m.sizeBytes;

  let got = 0;
  let lastPct = -1;
  const progress = new Transform({
    transform(chunk: Buffer, _e, cb) {
      got += chunk.length;
      const pct = total ? Math.floor((got / total) * 100) : 0;
      if (pct !== lastPct) {
        lastPct = pct;
        rewriteLine(`  ${bar(pct)} ${c.dim(`${bytes(got)}/${bytes(total)}`)}`);
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(res.body as any), progress, createWriteStream(tmp));
  } catch (e) {
    try { await unlink(tmp); } catch { /* ignore */ }
    throw e;
  }
  await rename(tmp, finalPath);
  if (process.stdout.isTTY) process.stdout.write('\n');
  console.log(c.green(`✓ installed ${m.displayName}`));
  return finalPath;
}

export async function removeModel(id: string): Promise<void> {
  const m = getModel(id);
  if (!m) throw new Error(`unknown model: ${id}`);
  try {
    await unlink(modelPath(m));
    console.log(c.green(`✓ removed ${m.displayName}`));
  } catch {
    console.log(c.dim(`(${m.displayName} was not installed)`));
  }
}
