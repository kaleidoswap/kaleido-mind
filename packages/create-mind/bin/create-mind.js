#!/usr/bin/env node
import { cpSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = process.argv[2];
if (arg === '-h' || arg === '--help') {
  console.log('Usage: npm create @kaleidorg/mind [directory]');
  process.exit(0);
}

const target = resolve(arg ?? 'kaleido-agent');
if (existsSync(target) && readdirSync(target).length) {
  console.error(`${target} exists and is not empty.`);
  process.exit(1);
}

const template = join(dirname(fileURLToPath(import.meta.url)), '..', 'template');
cpSync(template, target, { recursive: true });
renameSync(join(target, '_gitignore'), join(target, '.gitignore'));

const pkgPath = join(target, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.name = basename(target).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const dir = arg ?? 'kaleido-agent';
console.log(`
Created ${dir}.

  cd ${dir}
  npm install
  npm run start:offline     # fake node + scripted model: checks the setup, no download
  npm run start:mock        # fake node + Qwen3.5 2B on-device (first run downloads ~1.3 GB)

Already running Ollama or LM Studio?
  OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=qwen3.5:2b npm run start:mock

Against your RGB Lightning Node on signet:
  RLN_NODE_URL=http://localhost:3001 npm start

README.md has the rest, including the eval (npm run eval:mock).
`);
