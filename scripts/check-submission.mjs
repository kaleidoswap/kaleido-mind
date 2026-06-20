import { readFileSync, existsSync } from 'node:fs';

const required = [
  'NOTICE',
  'SUBMISSION.md',
  'REPRODUCE.md',
  'submission/remote-apis.yaml',
  'submission/evidence/README.md',
  'submission/video-script.md',
  'submission/dorahacks.md',
];

const errors = [];
for (const file of required) {
  if (!existsSync(file)) errors.push(`missing ${file}`);
}

const read = (file) => readFileSync(file, 'utf8');
const docs = ['README.md', 'SUBMISSION.md', 'REPRODUCE.md']
  .filter(existsSync)
  .map(read)
  .join('\n');

for (const stale of [
  'zero cloud calls',
  '@kaleidorg/mind-bench',
  'apps/bench/results',
  'Psy/MedPsy ·',
]) {
  if (docs.toLowerCase().includes(stale.toLowerCase())) {
    errors.push(`stale or unsupported claim remains: ${stale}`);
  }
}

const trading = read('packages/core/skills/kaleido-trading/SKILL.md');
for (const removed of [
  'kaleidoswap_get_spreads',
  'kaleidoswap_get_open_orders',
  'kaleidoswap_cancel_order',
  'kaleidoswap_get_position',
]) {
  if (trading.includes(removed)) errors.push(`removed trading tool remains: ${removed}`);
}

const rln = read('packages/core/skills/rgb-lightning-node/SKILL.md');
const toolsLine = rln.split('\n').find((line) => line.startsWith('tools:')) ?? '';
for (const name of toolsLine.replace(/^tools:\s*/, '').split(',').map((x) => x.trim()).filter(Boolean)) {
  if (!name.startsWith('rln_')) errors.push(`RLN skill contains non-rln tool: ${name}`);
}

if (errors.length) {
  console.error(errors.map((error) => `✗ ${error}`).join('\n'));
  process.exit(1);
}
console.log('✓ submission files and skill allowlists are internally consistent');
