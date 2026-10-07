// Build template/ from examples/rgb-agent so the starter never drifts from
// the example the repo tests.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..');
const repo = join(pkgDir, '..', '..');
const example = join(repo, 'examples', 'rgb-agent');
const out = join(pkgDir, 'template');

const core = JSON.parse(readFileSync(join(repo, 'packages', 'core', 'package.json'), 'utf8'));
const ex = JSON.parse(readFileSync(join(example, 'package.json'), 'utf8'));
const base = JSON.parse(readFileSync(join(repo, 'tsconfig.base.json'), 'utf8'));

const files = new Map();
for (const f of readdirSync(join(example, 'src'))) {
  if (f.endsWith('.ts')) files.set(`src/${f}`, readFileSync(join(example, 'src', f), 'utf8'));
}
files.set('README.md', readFileSync(join(pkgDir, 'TEMPLATE_README.md'), 'utf8'));
files.set('_gitignore', 'node_modules\n*.log\n.env\neval*.jsonl\n');
files.set(
  'package.json',
  JSON.stringify(
    {
      name: 'kaleido-agent',
      version: '0.0.0',
      private: true,
      type: 'module',
      scripts: ex.scripts,
      dependencies: { ...ex.dependencies, '@kaleidorg/mind': `^${core.version}` },
      devDependencies: ex.devDependencies,
    },
    null,
    2,
  ) + '\n',
);
files.set(
  'tsconfig.json',
  JSON.stringify(
    { compilerOptions: { ...base.compilerOptions, noEmit: true, declaration: false, declarationMap: false, rootDir: './src' }, include: ['src/**/*'] },
    null,
    2,
  ) + '\n',
);


rmSync(out, { recursive: true, force: true });
for (const [name, body] of files) {
  mkdirSync(dirname(join(out, name)), { recursive: true });
  writeFileSync(join(out, name), body);
}
console.log(`template/ written from examples/rgb-agent (@kaleidorg/mind ^${core.version})`);
