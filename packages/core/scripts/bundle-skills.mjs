#!/usr/bin/env node
/**
 * bundle-skills — serialise one or more skill directories into a SkillBundle
 * JSON file, so hosts without a filesystem (React Native) can load the same
 * SKILL.md skills the Node fs loader reads.
 *
 * Usage:
 *   node bundle-skills.mjs --out <file.json> <skills-dir> [<more-dirs>...]
 *
 * Example (mobile: ship the packaged bitrefill skill + the app's own skills):
 *   node bundle-skills.mjs --out ./skills.bundle.json \
 *     node_modules/@kaleidorg/mind/skills/bitrefill ./skills
 *
 * Each positional arg may be either a single skill folder (contains SKILL.md)
 * or a parent folder of skill folders. References under <skill>/references/*.md
 * are inlined. The output matches the `SkillBundle` type in src/skills/bundle.ts.
 */

import { readdirSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

function parseArgs(argv) {
  const dirs = [];
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else dirs.push(argv[i]);
  }
  if (!out || dirs.length === 0) {
    console.error('usage: bundle-skills.mjs --out <file.json> <skills-dir> [<more-dirs>...]');
    process.exit(2);
  }
  return { out, dirs };
}

function readSkillFolder(dir) {
  const md = join(dir, 'SKILL.md');
  if (!existsSync(md)) return null;
  const refDir = join(dir, 'references');
  const references = existsSync(refDir)
    ? readdirSync(refDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((name) => ({ name, content: readFileSync(join(refDir, name), 'utf8') }))
    : [];
  return {
    dir: basename(dir),
    markdown: readFileSync(md, 'utf8'),
    ...(references.length ? { references } : {}),
  };
}

/** Expand a path into skill folders: itself if it has a SKILL.md, else its children. */
function collectSkillDirs(path) {
  if (!existsSync(path)) {
    console.error(`bundle-skills: path not found: ${path}`);
    return [];
  }
  if (existsSync(join(path, 'SKILL.md'))) return [path];
  return readdirSync(path)
    .map((e) => join(path, e))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, 'SKILL.md')))
    .sort();
}

const { out, dirs } = parseArgs(process.argv.slice(2));
const seen = new Set();
const skills = [];
for (const arg of dirs) {
  for (const skillDir of collectSkillDirs(arg)) {
    const s = readSkillFolder(skillDir);
    if (!s) continue;
    if (seen.has(s.dir)) {
      console.error(`bundle-skills: duplicate skill folder "${s.dir}" — skipping ${skillDir}`);
      continue;
    }
    seen.add(s.dir);
    skills.push(s);
  }
}

const bundle = { version: 1, skills };
writeFileSync(out, JSON.stringify(bundle, null, 2));
console.error(`bundle-skills: wrote ${skills.length} skill(s) → ${out} [${skills.map((s) => s.dir).join(', ')}]`);
