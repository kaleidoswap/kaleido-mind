/**
 * CLI tool source — the fourth tool mechanism (alongside in-process function
 * calling, MCP, and skills). Lets the agent run shell commands, e.g. a skill's
 * documented CLI path (`@bitrefill/cli`, `kaleido`, `git`, …).
 *
 * Command execution is INJECTED (`CommandRunner`) so this file has no Node
 * dependency and stays RN-safe — a Node host provides the runner (ideally via a
 * non-shell `execFile`-style helper); React Native simply never provides one.
 * Guarded by a required allowlist of command prefixes, and confirmation-gated
 * by default since it runs real commands.
 */

import type { ToolDef } from '../types.js';
import type { ToolSource } from './source.js';

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Injected shell runner. The Node host supplies a safe implementation. */
export interface CommandRunner {
  run(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<CommandResult>;
}

export interface CliToolOptions {
  runner: CommandRunner;
  /**
   * Allowed command prefixes (REQUIRED — no empty allowlist). A command runs
   * only if it starts with one of these tokens, e.g. ['kaleido', 'git status',
   * 'npx @bitrefill/cli'].
   */
  allow: string[];
  cwd?: string;
  timeoutMs?: number;
  /** Confirmation gate (default true — it executes real commands). */
  requiresConfirmation?: boolean;
  /** Tool description override (e.g. name the specific CLI). */
  description?: string;
}

const RUN = 'run_command';

/** True if `command` is permitted by the allowlist (prefix match on tokens). */
export function isAllowed(command: string, allow: string[]): boolean {
  const cmd = command.trim();
  return allow.some((prefix) => {
    const p = prefix.trim();
    return p.length > 0 && (cmd === p || cmd.startsWith(p + ' '));
  });
}

export function createCliToolSource(opts: CliToolOptions): ToolSource {
  if (!opts.allow || opts.allow.length === 0) {
    throw new Error('createCliToolSource: a non-empty `allow` allowlist is required');
  }

  const tool: ToolDef = {
    name: RUN,
    description:
      opts.description ??
      `Run an allowed shell command and return its output. Allowed commands start ` +
        `with: ${opts.allow.join(', ')}. Use for documented CLI tools.`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The full command line to run' },
      },
      required: ['command'],
    },
    requiresConfirmation: opts.requiresConfirmation ?? true,
  };

  async function execute(_name: string, args: Record<string, unknown>): Promise<unknown> {
    const command = String(args.command ?? '').trim();
    if (!command) throw new Error('run_command: command is required');
    if (!isAllowed(command, opts.allow)) {
      throw new Error(
        `run_command: "${command.split(' ')[0]}" is not allowed. Allowed: ${opts.allow.join(', ')}`,
      );
    }
    const res = await opts.runner.run(command, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
    const out = (res.stdout || '').trim();
    const err = (res.stderr || '').trim();
    if (res.code !== 0) {
      return `exit ${res.code}${err ? `\n${err}` : ''}${out ? `\n${out}` : ''}`.trim();
    }
    return out || '(no output)';
  }

  return {
    id: 'cli',
    listTools: () => [tool],
    has: (name) => name === RUN,
    execute,
  };
}
