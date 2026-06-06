#!/usr/bin/env node
/**
 * kaleido-mind — manage and run the local AI brain from your terminal.
 *
 *   kaleido-mind                 dashboard (first run → guided setup)
 *   kaleido-mind setup           (re)run the guided setup
 *   kaleido-mind models          what's offered + what's installed
 *   kaleido-mind pull <id>       download a model
 *   kaleido-mind rm <id>         remove a model
 *   kaleido-mind run [--rag]     chat with the brain  (--mock to skip QVAC)
 *   kaleido-mind status          what's installed / selected / running
 *   kaleido-mind tools           tools the brain can use
 *   kaleido-mind skills          skills the brain can enter
 */

import * as os from 'node:os';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { capabilityProfile } from '@kaleidorg/mind';
import { SkillRegistry } from '@kaleidorg/mind';
import { loadSkillsDir, packagedSkillsDir } from '@kaleidorg/mind/skills';
import { banner, box, table, c, bytes, dot } from './ui.js';
import { CATALOG, getModel, recommendChatModel, type CatalogModel } from './catalog.js';
import { listInstalled, isInstalled, pullModel, removeModel } from './models.js';
import { loadConfig, saveConfig, type CliConfig } from './config.js';
import { buildAgent, runChat } from './chat.js';
import { runBench } from './bench.js';
import { runEvalSuite } from './eval/orchestrate.js';
import { renderAnsi, summaryTable } from './eval/report.js';
import { type Mechanism } from './eval/run.js';
import { join } from 'node:path';

const hw = () => ({ ramBytes: os.totalmem(), cores: os.cpus().length, arch: os.arch(), platform: os.platform() });
const ramGb = (b: number) => (b / 1024 ** 3).toFixed(1);

function hwBox(): string {
  const h = hw();
  const caps = capabilityProfile({ ramBytes: h.ramBytes, modelCtxTokens: 8192, hasEmbeddings: true });
  return box(
    [
      `${c.dim('machine')}   ${h.platform}/${h.arch} · ${h.cores} cores · ${ramGb(h.ramBytes)} GB RAM`,
      `${c.dim('features')}  memory ${dot(caps.memory)}  semantic ${dot(caps.semanticMemory)}  RAG ${dot(caps.rag)}`,
    ],
    'Your hardware',
    c.teal,
  );
}

function modelRows(installed: Set<string>, recommendedId?: string): string[][] {
  return CATALOG.map((m) => [
    installed.has(m.id) ? c.green('●') : c.gray('○'),
    m.id === recommendedId ? c.violet(m.id) : m.id,
    m.kind === 'embeddings' ? c.dim(m.params) : m.params,
    bytes(m.sizeBytes),
    `${c.dim('~' + m.ramHintGb + 'GB')}`,
    m.id === recommendedId ? c.violet('★ recommended') : c.dim(m.notes.slice(0, 42)),
  ]);
}

async function cmdModels(): Promise<void> {
  const installed = new Set((await listInstalled()).map((m) => m.id));
  const rec = recommendChatModel(os.totalmem());
  console.log(`\n${c.bold('Models')} ${c.dim('(● installed · ○ available)')}\n`);
  console.log(table([[c.dim(''), c.dim('id'), c.dim('params'), c.dim('size'), c.dim('ram'), c.dim('notes')], ...modelRows(installed, rec.id)]));
  console.log(`\n${c.dim('install:')} kaleido-mind pull <id>    ${c.dim('run:')} kaleido-mind run\n`);
}

async function cmdStatus(): Promise<void> {
  const cfg = await loadConfig();
  const installed = await listInstalled();
  const sel = cfg.modelId ? getModel(cfg.modelId) : undefined;
  console.log('');
  console.log(hwBox());
  console.log(
    box(
      [
        `${c.dim('selected')}  ${sel ? c.bold(sel.displayName) : c.yellow('none — run setup')}`,
        `${c.dim('installed')} ${installed.length ? installed.map((m) => m.id).join(', ') : c.dim('none')}`,
        `${c.dim('RAG')}       ${cfg.rag ? c.green('on') : c.dim('off')}`,
        `${c.dim('mcp')}       ${cfg.mcpEntry ? cfg.mcpEntry : c.dim('not set')}`,
      ],
      'Brain',
      c.violet,
    ),
  );
  console.log('');
}

async function cmdTools(): Promise<void> {
  const cfg = await loadConfig();
  const agent = await buildAgent(cfg, { mock: true, rag: cfg.rag }); // mock: list without loading a model
  console.log(`\n${c.bold('Tools')} ${c.dim('the brain can call')}\n`);
  for (const t of await agent.tools.listTools()) console.log(`  ${c.teal(t.name)}${t.requiresConfirmation ? c.yellow(' ⚠') : ''}  ${c.dim(t.description.slice(0, 70))}`);
  console.log('');
}

function cmdSkills(): void {
  const skills = new SkillRegistry(loadSkillsDir(packagedSkillsDir()));
  console.log(`\n${c.bold('Skills')} ${c.dim('the brain can enter')}\n`);
  for (const s of skills.list()) {
    console.log(`  ${c.cyan(s.name)}${s.tools ? c.dim(` [${s.tools.length} tools]`) : ''}`);
    console.log(`    ${c.dim(s.description.slice(0, 90))}`);
  }
  console.log('');
}

async function cmdSetup(): Promise<void> {
  console.log(banner());
  console.log(hwBox());
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const cfg = await loadConfig();
  const installed = new Set((await listInstalled()).map((m) => m.id));
  const rec = recommendChatModel(os.totalmem());

  console.log(`\n${c.bold('1) Pick a chat model')} ${c.dim('— ★ recommended for your RAM')}\n`);
  const chats = CATALOG.filter((m) => m.kind === 'llm');
  chats.forEach((m, i) =>
    console.log(`  ${c.violet(String(i + 1))}. ${m.id === rec.id ? c.violet(m.displayName + ' ★') : m.displayName}  ${c.dim(`${bytes(m.sizeBytes)} · ~${m.ramHintGb}GB${installed.has(m.id) ? ' · installed' : ''}`)}`),
  );
  const pick = (await rl.question(`\n${c.violet('model')} [${chats.findIndex((m) => m.id === rec.id) + 1}]: `)).trim();
  const chosen: CatalogModel = chats[(pick ? Number(pick) : chats.findIndex((m) => m.id === rec.id) + 1) - 1] ?? rec;

  const ragAns = (await rl.question(`${c.violet('enable RAG')}? (downloads gte-large, ~670MB) [y/N]: `)).trim().toLowerCase();
  const rag = ragAns === 'y' || ragAns === 'yes';
  rl.close();

  cfg.modelId = chosen.id;
  cfg.rag = rag;
  cfg.setupDone = true;
  await saveConfig(cfg);
  console.log(`\n${c.green('✓')} selected ${c.bold(chosen.displayName)}${rag ? c.dim(' + RAG') : ''}`);

  if (!installed.has(chosen.id)) {
    console.log(c.dim('\ndownloading your model…\n'));
    await pullModel(chosen.id);
  }
  if (rag && !installed.has('gte-large')) {
    console.log(c.dim('\ndownloading the embedding model…\n'));
    await pullModel('gte-large');
  }
  console.log(`\n${c.green('Ready.')} Start chatting:  ${c.bold('kaleido-mind run' + (rag ? ' --rag' : ''))}\n`);
}

async function cmdRun(): Promise<void> {
  const cfg = await loadConfig();
  const mock = process.argv.includes('--mock');
  const rag = process.argv.includes('--rag') || cfg.rag;
  if (!cfg.setupDone && !mock) {
    console.log(c.yellow('No setup yet — running guided setup first.\n'));
    await cmdSetup();
    return;
  }
  const agent = await buildAgent(cfg, { mock, rag });
  await runChat(agent);
}

async function dashboard(): Promise<void> {
  const cfg = await loadConfig();
  console.log(banner());
  if (!cfg.setupDone) {
    console.log(box([`Welcome! Let's set up your local brain.`, '', `Run  ${c.bold('kaleido-mind setup')}  to begin.`], 'First run', c.pink));
    console.log('');
    return;
  }
  await cmdStatus();
  console.log(c.dim('  run · models · tools · skills · setup\n'));
}

async function main(): Promise<void> {
  // Ignore a bare `--` (pnpm forwards it) and treat the first non-flag as the command.
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const cmd = args.find((a) => !a.startsWith('-'));
  switch (cmd) {
    case undefined: return dashboard();
    case 'setup': return cmdSetup();
    case 'models': return cmdModels();
    case 'status': return cmdStatus();
    case 'tools': return cmdTools();
    case 'skills': return void cmdSkills();
    case 'run': case 'chat': return cmdRun();
    case 'bench': {
      const cfg = await loadConfig();
      const mock = args.includes('--mock');
      const rag = args.includes('--rag') || cfg.rag;
      const mi = args.indexOf('--model');
      if (mi >= 0 && args[mi + 1]) cfg.modelId = args[mi + 1];
      const agent = await buildAgent(cfg, { mock, rag });
      await runBench(agent, Date.now());
      if (agent.sdk?.close) await agent.sdk.close();
      return;
    }
    case 'eval': {
      const valOf = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
      const numOf = (n: string) => { const v = valOf(n); return v ? Number(v) : undefined; };
      const mock = args.includes('--mock');
      const mechs = valOf('--mechanisms')?.split(',') as Mechanism[] | undefined;
      console.log(c.dim(`\neval · ${mock ? 'MOCK' : 'QVAC'} — this loads each model + runs the matrix…`));
      let run;
      try {
        run = await runEvalSuite({ mock, models: valOf('--models')?.split(','), mechanisms: mechs, per: numOf('--per') ?? 4, sample: numOf('--sample'), onProgress: (m) => console.log(c.dim(`  ${m}`)) });
      } catch (e) { console.log(c.yellow((e as Error).message)); return; }
      console.log(renderAnsi(run.agg));
      console.log('\n' + c.bold('Matrix (task success):'));
      console.log(summaryTable(run.agg));
      console.log(`\n${c.green('✓')} report → ${c.bold(join(run.dir, 'report.html'))}`);
      console.log(c.dim(`  view all runs: kaleido-mind serve\n`));
      return;
    }
    case 'serve': {
      const valOf = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
      const { serve } = await import('./eval/server.js');
      await serve(Number(valOf('--port') ?? 4178));
      return; // serve() keeps the process alive
    }
    case 'pull': case 'install': {
      const id = args[args.indexOf(cmd) + 1];
      if (!id) { console.log(c.yellow('usage: kaleido-mind pull <id>  (see `kaleido-mind models`)')); return; }
      await pullModel(id);
      const cfg = await loadConfig();
      if (!cfg.modelId && getModel(id)?.kind === 'llm') { cfg.modelId = id; cfg.setupDone = true; await saveConfig(cfg); }
      return;
    }
    case 'rm': case 'remove': {
      const id = args[args.indexOf(cmd) + 1];
      if (!id) { console.log(c.yellow('usage: kaleido-mind rm <id>')); return; }
      return removeModel(id);
    }
    case 'help': case '--help': case '-h':
      console.log(banner());
      console.log(table([
        [c.violet('setup'), c.dim('guided first-run setup')],
        [c.violet('models'), c.dim('list offered + installed models')],
        [c.violet('pull <id>'), c.dim('download a model')],
        [c.violet('rm <id>'), c.dim('remove a model')],
        [c.violet('run [--rag]'), c.dim('chat with the brain (--mock to skip QVAC)')],
        [c.violet('bench [--model id]'), c.dim('quick classic-requests smoke benchmark → JSONL')],
        [c.violet('eval [--models a,b]'), c.dim('tool-use matrix (fc/mcp/skill/cli) → graphical HTML report')],
        [c.violet('serve [--port]'), c.dim('web dashboard to browse + trigger eval runs')],
        [c.violet('status'), c.dim('hardware + what is installed/selected')],
        [c.violet('tools'), c.dim('tools the brain can call')],
        [c.violet('skills'), c.dim('skills the brain can enter')],
      ]));
      console.log('');
      return;
    default:
      console.log(c.yellow(`unknown command: ${cmd}`));
      console.log(c.dim('try `kaleido-mind help`'));
  }
}

main().catch((e) => { console.error(c.red('error:'), e?.message ?? e); process.exit(1); });
