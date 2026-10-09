/** Optional Node-only storage; never imported by the portable core entry point. */
import { mkdir, open, readdir, readFile, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateDatasetRecord, type DatasetRecord } from './dataset.js';

/** Dedicated local directory. Retention is enforced on reads; call purge periodically. */
export class LocalDatasetStore {
  constructor(private readonly dir: string, private readonly retentionDays = 30,
    private readonly now: () => number = Date.now) {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) throw new Error('retentionDays must be positive');
  }
  private expired(record: DatasetRecord) {
    return Date.parse(record.createdAt) < this.now() - this.retentionDays * 86_400_000;
  }
  /** Suitable for DatasetCollector.appendLine. Atomic record files, private permissions. */
  async appendLine(line: string): Promise<void> {
    const record: unknown = JSON.parse(line);
    validateDatasetRecord(record);
    if (!record.consent.collection || this.expired(record)) throw new Error('Record is not eligible for storage');
    if (Date.parse(record.createdAt) > this.now() + 60_000) throw new Error('Record timestamp is in the future');
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, `${randomUUID()}.jsonl`);
    const temporary = `${file}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(temporary).catch(() => {});
      throw error;
    }
    await handle.close();
    try { await rename(temporary, file); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  private async entries(): Promise<Array<{ path: string; record: DatasetRecord }>> {
    let names: string[];
    try { names = await readdir(this.dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const records: Array<{ path: string; record: DatasetRecord }> = [];
    for (const name of names.sort()) {
      if (!/^[0-9a-f-]{36}\.jsonl$/.test(name)) continue;
      const path = join(this.dir, name);
      const record: unknown = JSON.parse(await readFile(path, 'utf8'));
      validateDatasetRecord(record); // Fail visibly on corrupt records, never silently skip.
      records.push({ path, record });
    }
    return records;
  }
  async read(): Promise<DatasetRecord[]> {
    return (await this.entries()).filter(e => !this.expired(e.record)).map(e => e.record);
  }
  async purgeExpired(): Promise<number> {
    const entries = (await this.entries()).filter(e => this.expired(e.record));
    for (const entry of entries) await unlink(entry.path);
    return entries.length;
  }
  /** Withdrawal/deletion: the host must also delete any previously exported copies. */
  async deleteGroup(groupId: string): Promise<number> {
    const entries = (await this.entries()).filter(e => e.record.groupId === groupId);
    for (const entry of entries) await unlink(entry.path);
    return entries.length;
  }
}
