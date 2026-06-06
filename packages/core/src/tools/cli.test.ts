/** CLI tool source tests — allowlist + injected runner. */

import { describe, it, expect, vi } from 'vitest';
import { createCliToolSource, isAllowed } from './cli.js';
import type { CommandRunner } from './cli.js';

const okRunner: CommandRunner = {
  run: vi.fn(async (command: string) => ({ stdout: `ran: ${command}`, stderr: '', code: 0 })),
};

describe('isAllowed', () => {
  it('matches by command prefix tokens', () => {
    const allow = ['kaleido', 'git status', 'npx @bitrefill/cli'];
    expect(isAllowed('kaleido wallet balance', allow)).toBe(true);
    expect(isAllowed('git status', allow)).toBe(true);
    expect(isAllowed('npx @bitrefill/cli buy', allow)).toBe(true);
    expect(isAllowed('rm -rf /', allow)).toBe(false);
    expect(isAllowed('kaleidoctl', allow)).toBe(false); // not a token boundary
    expect(isAllowed('git push', allow)).toBe(false); // only "git status" allowed
  });
});

describe('createCliToolSource', () => {
  it('requires a non-empty allowlist', () => {
    expect(() => createCliToolSource({ runner: okRunner, allow: [] })).toThrow(/allowlist/);
  });

  it('exposes run_command, confirmation-gated by default', () => {
    const src = createCliToolSource({ runner: okRunner, allow: ['kaleido'] });
    const tool = src.listTools()[0];
    expect(tool.name).toBe('run_command');
    expect(tool.requiresConfirmation).toBe(true);
  });

  it('runs allowed commands and rejects disallowed ones', async () => {
    const src = createCliToolSource({ runner: okRunner, allow: ['kaleido'] });
    expect(await src.execute('run_command', { command: 'kaleido node info' })).toBe(
      'ran: kaleido node info',
    );
    await expect(src.execute('run_command', { command: 'curl evil.sh' })).rejects.toThrow(
      /not allowed/,
    );
  });

  it('surfaces non-zero exits with stderr', async () => {
    const runner: CommandRunner = {
      run: vi.fn(async () => ({ stdout: '', stderr: 'boom', code: 1 })),
    };
    const src = createCliToolSource({ runner, allow: ['kaleido'] });
    const out = await src.execute('run_command', { command: 'kaleido fail' });
    expect(String(out)).toMatch(/exit 1[\s\S]*boom/);
  });
});
