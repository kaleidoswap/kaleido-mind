import { it, expect } from 'vitest';
import { TurnLogger, type LoggerIO } from './logger.js';
it('redacts content and tool result arguments by default and rejects path traversal', async () => {
  const lines: string[] = [];
  const io: LoggerIO = { ensureDir: async () => {}, appendLine: async (_, line) => { lines.push(line); }, hash: () => 'abc12345', now: () => new Date('2026-10-09') };
  const logger = new TurnLogger({ dir: '/logs', device: 'playground', io });
  const input = { session_id: 'safe', model: { provider: 'mock', name: 'mock' }, system_hash: 'hash', tools: [], messages: [{ role: 'user' as const, content: 'secret person' }], decision: { tool_calls: [], final_text: 'secret person' }, results: [{ name: 'test', arguments: { mnemonic: 'secret seed', to: 'secret person' }, result: { apiKey: 'secret key', address: 'secret address' } }], latency_ms: { reason: 1, total: 1 }, meta: { raw: 'secret' } };
  await logger.log(input);
  expect(lines[0]).not.toContain('secret');
  expect(JSON.parse(lines[0]!).messages).toEqual([]);
  await expect(logger.log({ ...input, session_id: '../escape' })).rejects.toThrow('session ID');
  expect(lines).toHaveLength(1);
});
