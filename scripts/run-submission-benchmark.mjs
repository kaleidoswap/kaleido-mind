import { spawn, spawnSync } from 'node:child_process';
import {
  createReadStream,
  createWriteStream,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus, freemem, homedir, platform, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2).filter((arg) => arg !== '--');
const flag = (name) => argv.includes(name);
const value = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

if (flag('--help')) {
  console.log(`KaleidoMind submission benchmark

Usage:
  pnpm submission:evidence -- [options]

Options:
  --quick             One model, one repeat, one paraphrase per intent
  --mock              Validate the harness without loading QVAC models
  --models <ids>      Comma-separated catalog ids
  --repeats <n>       Repeats per case (default: 3)
  --per <n>           Track A paraphrases per intent (default: 2)
  --output <dir>      Parent evidence directory
  --allow-dirty       Permit a real rehearsal from an uncommitted worktree

Environment aliases: MODELS, REPEATS, PER, EVIDENCE_DIR.
`);
  process.exit(0);
}

const mock = flag('--mock');
const quick = flag('--quick');
const allowDirty = flag('--allow-dirty');
const models = value('--models') ?? process.env.MODELS ?? (quick ? 'qwen3-0.6b' : 'qwen3-0.6b,qwen3-1.7b,qwen3-4b');
const repeats = value('--repeats') ?? process.env.REPEATS ?? (quick ? '1' : '3');
const per = value('--per') ?? process.env.PER ?? (quick ? '1' : '2');
const evidenceRoot = resolve(value('--output') ?? process.env.EVIDENCE_DIR ?? 'submission/evidence');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = join(evidenceRoot, mock ? `mock-${stamp}` : `desktop-${stamp}`);
const partialDir = `${outputDir}.partial`;
const root = process.cwd();
const mindLogs = join(homedir(), '.kaleido', 'mind', 'logs');
const modelsDir = join(homedir(), '.kaleido', 'models');

const catalogFiles = {
  'qwen3-0.6b': 'Qwen3-0.6B-Q4_K_M.gguf',
  'qwen3-1.7b': 'Qwen3-1.7B-Q4_K_M.gguf',
  'qwen3-4b': 'Qwen3-4B-Q4_K_M.gguf',
  'qwen3-8b': 'Qwen3-8B-Q4_K_M.gguf',
  'qwen3-14b': 'Qwen3-14B-Q4_K_M.gguf',
  'medpsy-4b': 'medpsy-4b-q4_k_m-imat.gguf',
};

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const corePackage = JSON.parse(readFileSync('packages/core/package.json', 'utf8'));
const qvacVersion =
  packageJson.dependencies?.['@qvac/sdk'] ??
  corePackage.devDependencies?.['@qvac/sdk'] ??
  'unknown';

const git = (...args) =>
  spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout?.trim() || 'unknown';
const dirty = git('status', '--porcelain') !== '';

if (!mock && dirty && !allowDirty) {
  console.error('Refusing a real evidence run from a dirty worktree.');
  console.error('Commit the submission first, or use --allow-dirty for a rehearsal.');
  process.exit(2);
}

function macHardware() {
  if (platform() !== 'darwin') return {};
  const read = (key) =>
    spawnSync('sysctl', ['-n', key], { encoding: 'utf8' }).stdout?.trim() || undefined;
  const os = spawnSync('sw_vers', { encoding: 'utf8' }).stdout?.trim() || undefined;
  return { modelIdentifier: read('hw.model'), osVersion: os };
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function logDirs() {
  if (!existsSync(mindLogs)) return new Set();
  return new Set(readdirSync(mindLogs).filter((name) => name.startsWith('eval-')));
}

mkdirSync(partialDir, { recursive: true });
const beforeReports = logDirs();
const selectedModels = models.split(',').map((id) => id.trim()).filter(Boolean);
const modelEvidence = [];

if (!mock) {
  const missing = [];
  for (const id of selectedModels) {
    const filename = catalogFiles[id];
    if (!filename) {
      missing.push(`${id} (not in the benchmark catalog)`);
      continue;
    }
    const path = join(modelsDir, filename);
    if (!existsSync(path)) {
      missing.push(`${id} (${path})`);
      continue;
    }
    console.log(`Hashing ${filename}…`);
    modelEvidence.push({ id, filename, sha256: await sha256(path) });
  }
  if (missing.length) {
    writeFileSync(join(partialDir, 'INCOMPLETE'), `Missing models:\n${missing.join('\n')}\n`);
    console.error(`Missing benchmark models:\n- ${missing.join('\n- ')}`);
    process.exit(2);
  }
}

const tracks = [
  ['safety', ['safety', ...(mock ? ['--mock'] : ['--models', models]), '--repeats', repeats]],
  ['multistep', ['multistep', ...(mock ? ['--mock'] : ['--models', models]), '--repeats', repeats]],
  ['quality', ['quality', ...(mock ? ['--mock'] : ['--models', models]), '--repeats', repeats]],
  ['capability', ['eval', ...(mock ? ['--mock'] : ['--models', models]), '--per', per, '--repeats', repeats]],
];

const manifest = {
  schema: 'kaleidomind.benchmark.v1',
  startedAt: new Date().toISOString(),
  mode: mock ? 'mock' : 'qvac',
  repository: {
    commit: git('rev-parse', 'HEAD'),
    branch: git('branch', '--show-current'),
    dirty,
  },
  software: {
    node: process.version,
    mind: corePackage.version,
    qvacSdk: qvacVersion,
  },
  parameters: {
    models: selectedModels,
    repeats: Number(repeats),
    per: Number(per),
    quick,
    order: tracks.map(([name]) => name),
  },
  models: modelEvidence,
  hardware: {
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model,
    logicalCores: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart: freemem(),
    ...macHardware(),
  },
  tracks: [],
};

let activeChild;
let interruptedSignal;

function persistManifest(success = false) {
  manifest.endedAt = new Date().toISOString();
  manifest.success = success;
  if (interruptedSignal) manifest.interruptedBy = interruptedSignal;
  writeFileSync(join(partialDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interruptedSignal = signal;
    activeChild?.kill(signal);
    writeFileSync(join(partialDir, 'INCOMPLETE'), `Interrupted by ${signal}\n`);
    persistManifest(false);
    process.exitCode = 130;
  });
}

function runTrack(name, args) {
  return new Promise((resolveTrack) => {
    const startedAt = new Date();
    const stdout = createWriteStream(join(partialDir, `${name}.stdout.log`));
    const stderr = createWriteStream(join(partialDir, `${name}.stderr.log`));
    activeChild = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], {
      cwd: join(root, 'apps/cli'),
      env: {
        ...process.env,
        KALEIDO_EVAL_JSON: join(partialDir, `${name}.raw.json`),
        KALEIDO_EVAL_REPORT_DIR: join(partialDir, 'reports'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChild.stdout.pipe(stdout);
    activeChild.stderr.pipe(stderr);
    activeChild.stdout.pipe(process.stdout);
    activeChild.stderr.pipe(process.stderr);
    activeChild.on('close', (code, signal) => {
      activeChild = undefined;
      const endedAt = new Date();
      manifest.tracks.push({
        name,
        command: `node --import tsx src/index.ts ${args.join(' ')}`,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        exitCode: code,
        signal,
      });
      persistManifest(false);
      resolveTrack(code ?? 1);
    });
  });
}

let failed = false;
for (const [name, args] of tracks) {
  if (interruptedSignal) break;
  console.log(`\n→ ${name}`);
  const code = await runTrack(name, args);
  if (code !== 0) {
    failed = true;
    console.error(`Track ${name} failed with exit code ${code}; stopping.`);
    break;
  }
}

const newReports = [...logDirs()].filter((name) => !beforeReports.has(name));
if (newReports.length) {
  const reportsDir = join(partialDir, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  for (const name of newReports) cpSync(join(mindLogs, name), join(reportsDir, name), { recursive: true });
  manifest.reports = newReports.map((name) => `reports/${name}`);
}
if (existsSync(join(partialDir, 'reports'))) {
  manifest.reports = readdirSync(join(partialDir, 'reports')).map((name) => `reports/${name}`);
}

const success = !failed && !interruptedSignal && manifest.tracks.length === tracks.length;
persistManifest(success);
if (success) {
  rmSync(join(partialDir, 'INCOMPLETE'), { force: true });
  renameSync(partialDir, outputDir);
  console.log(`\n✓ Complete evidence written to ${outputDir}`);
} else {
  writeFileSync(join(partialDir, 'INCOMPLETE'), 'This run is not submission evidence.\n');
  console.error(`\n✗ Incomplete run kept at ${partialDir}`);
  process.exitCode = interruptedSignal ? 130 : 1;
}
