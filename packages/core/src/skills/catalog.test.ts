/**
 * Skill catalog checks: every packaged skill must name real tools and every
 * worked example must be a valid call, both against the in-app contracts and
 * against kaleido-mcp (src/skills/mcp-tools.snapshot.json, refreshed with
 * scripts/snapshot-mcp-tools.mjs).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDef } from '../types.js';
import { loadSkillsDir, packagedSkillsDir } from './loader.js';
import { SkillRegistry } from './registry.js';
import { selectAvailableSkill } from './select.js';
import { createSkillReferenceToolSource } from './reference-source.js';
import { WALLET_TOOLS } from '../wallet/contract.js';
import { KALEIDOSWAP_TOOLS } from '../kaleidoswap/contract.js';
import { LSPS1_TOOLS } from '../lsps1/contract.js';
import { SUBMARINE_TOOLS } from '../submarine/contract.js';
import { FLASHNET_TOOLS } from '../flashnet/contract.js';
import { BITREFILL_TOOLS } from '../bitrefill/contract.js';
import { createBtcMapToolSource } from '../knowledge/btc-map.js';
import { createL402ToolSource } from '../tools/l402.js';
import { createRagToolSource } from '../rag/tool.js';
import type { Retriever } from '../rag/retriever.js';
import { validateToolArgs } from '../guards.js';
import { estimateTokens } from '../context/budget.js';

interface SnapshotTool {
  required: string[];
  properties: Record<string, { type: string; description?: string }>;
}

const SKILLS_DIR = packagedSkillsDir();
const skills = loadSkillsDir(SKILLS_DIR);
const registry = new SkillRegistry(skills);

const mcp: Record<string, SnapshotTool> = JSON.parse(
  readFileSync(new URL('./mcp-tools.snapshot.json', import.meta.url), 'utf8'),
).tools;

const core = new Map<string, ToolDef>();
for (const def of [
  ...WALLET_TOOLS,
  ...KALEIDOSWAP_TOOLS,
  ...LSPS1_TOOLS,
  ...SUBMARINE_TOOLS,
  ...FLASHNET_TOOLS,
  ...BITREFILL_TOOLS,
  ...createBtcMapToolSource({}).listTools(),
  ...createL402ToolSource({ payInvoice: async () => ({ preimage: '' }) }).listTools(),
  ...createRagToolSource({} as Retriever).listTools(),
  ...createSkillReferenceToolSource(registry).listTools(),
] as ToolDef[]) core.set(def.name, def);

/**
 * Same name, different tool. kaleido-mcp keeps `spark_pay_invoice` as a legacy
 * alias of `spark_pay_spark_invoice` (Spark invoices); its BOLT11 payer is
 * `spark_pay_lightning_invoice`. The in-app `spark_pay_invoice` pays BOLT11, so
 * skills that use it must require an in-app-only tool.
 */
const NAME_COLLISIONS = new Set(['spark_pay_invoice']);

const mcpDef = (name: string): ToolDef => ({
  name,
  description: '',
  parameters: { type: 'object', properties: mcp[name]!.properties, required: mcp[name]!.required },
});

function surfaces(name: string): Array<{ surface: string; def: ToolDef }> {
  const out: Array<{ surface: string; def: ToolDef }> = [];
  if (core.has(name)) out.push({ surface: 'core', def: core.get(name)! });
  if (mcp[name] && !NAME_COLLISIONS.has(name)) out.push({ surface: 'kaleido-mcp', def: mcpDef(name) });
  return out;
}

function props(def: ToolDef): string[] {
  return Object.keys((def.parameters as { properties?: object }).properties ?? {});
}

function required(def: ToolDef): string[] {
  return ((def.parameters as { required?: string[] }).required ?? []);
}

function frontmatterList(name: string, key: string): string[] {
  const skill = skills.find((s) => s.name === name)!;
  if (key === 'tools') return skill.tools ?? [];
  return (skill.metadata?.[key] ?? '').split(',').map((t) => t.trim()).filter(Boolean);
}

/** Every `tool_name {json}` call written in a skill or one of its references. */
function exampleCalls(dir: string): Array<{ file: string; tool: string; json: string }> {
  const files = [join(dir, 'SKILL.md')];
  const refs = join(dir, 'references');
  if (existsSync(refs)) files.push(...readdirSync(refs).filter((f) => f.endsWith('.md')).map((f) => join(refs, f)));
  const out: Array<{ file: string; tool: string; json: string }> = [];
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(/`([a-z][a-z0-9_]*) (\{[^`]*\})`/g)) {
      if (core.has(m[1]!) || mcp[m[1]!]) out.push({ file, tool: m[1]!, json: m[2]! });
    }
  }
  return out;
}

const isPlaceholder = (v: unknown) => typeof v === 'string' && /^<.*>$|…/.test(v);

describe('skill catalog', () => {
  it('ships skills', () => {
    expect(skills.length).toBeGreaterThan(5);
  });

  it.each(skills.map((s) => [s.name]))('%s: every tool exists on a surface', (name) => {
    const missing = [...frontmatterList(name, 'tools'), ...frontmatterList(name, 'requires-tools')]
      .filter((t) => !core.has(t) && !mcp[t]);
    expect(missing).toEqual([]);
  });

  it.each(skills.map((s) => [s.name]))('%s: requires-tools are in tools', (name) => {
    const tools = new Set(frontmatterList(name, 'tools'));
    expect(frontmatterList(name, 'requires-tools').filter((t) => !tools.has(t))).toEqual([]);
  });

  it.each(skills.map((s) => [s.name]))('%s: a colliding tool name is scoped to the app', (name) => {
    const uses = frontmatterList(name, 'tools').some((t) => NAME_COLLISIONS.has(t));
    if (!uses) return;
    const req = frontmatterList(name, 'requires-tools');
    expect(req.length > 0 && req.some((t) => core.has(t) && !mcp[t])).toBe(true);
  });

  it.each(skills.map((s) => [s.name, s.dir!]))('%s: examples are valid calls', (name, dir) => {
    const scoped = new Set(frontmatterList(name, 'tools'));
    const errors: string[] = [];
    for (const call of exampleCalls(dir)) {
      const where = `${call.file.slice(SKILLS_DIR.length)}: ${call.tool} ${call.json}`;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.json);
      } catch {
        errors.push(`${where} — not JSON`);
        continue;
      }
      if (call.file.endsWith('SKILL.md') && scoped.size && !scoped.has(call.tool)) {
        errors.push(`${where} — tool not in the skill's tools`);
      }
      for (const { surface, def } of surfaces(call.tool)) {
        const known = props(def);
        for (const k of Object.keys(args)) if (!known.includes(k)) errors.push(`${where} — "${k}" unknown on ${surface}`);
        for (const k of required(def)) if (args[k] == null) errors.push(`${where} — "${k}" required on ${surface}`);
        const concrete = Object.fromEntries(Object.entries(args).filter(([, v]) => !isPlaceholder(v)));
        const check = validateToolArgs(def, concrete);
        for (const e of check.errors) if (!/is required/.test(e)) errors.push(`${where} — ${surface}: ${e}`);
      }
    }
    expect(errors).toEqual([]);
  });

  it.each(skills.map((s) => [s.name]))('%s: tool names in the prose exist', (name) => {
    const body = skills.find((s) => s.name === name)!.instructions;
    const prefixed = /^(rln|wdk|kaleidoswap|kaleido_node|spark|flashnet|bitrefill|mpp|l402|liquid|arkade)_[a-z0-9_]+$/;
    const unknown = [...body.matchAll(/`([a-z][a-z0-9_]*)[` ]/g)]
      .map((m) => m[1]!)
      .filter((w) => prefixed.test(w) && !core.has(w) && !mcp[w]);
    expect([...new Set(unknown)]).toEqual([]);
  });

  it.each(skills.map((s) => [s.name]))('%s: body stays short', (name) => {
    const skill = skills.find((s) => s.name === name)!;
    expect(estimateTokens(skill.instructions)).toBeLessThanOrEqual(600);
    expect(skill.description.length).toBeLessThanOrEqual(320);
  });
});

describe('core contracts match kaleido-mcp', () => {
  it('shared tool names take the same arguments', () => {
    const errors: string[] = [];
    for (const [name, def] of core) {
      const m = mcp[name];
      if (!m || NAME_COLLISIONS.has(name)) continue;
      const mcpProps = Object.keys(m.properties);
      const coreProps = props(def);
      for (const p of coreProps) if (!mcpProps.includes(p)) errors.push(`${name}: "${p}" is not a kaleido-mcp argument`);
      for (const r of m.required) if (!coreProps.includes(r)) errors.push(`${name}: kaleido-mcp requires "${r}"`);
    }
    expect(errors).toEqual([]);
  });
});

describe('skill selection by surface', () => {
  const mcpTools = Object.keys(mcp);
  const inApp = [...core.keys()];

  it.each([
    ['Which RGB assets do I hold, and what are the balances?', 'rgb-lightning-node'],
    ['Get a quote to swap 0.0005 BTC into USDT on KaleidoSwap.', 'kaleido-trading'],
    ['Issue a token named Skill Test, ticker SKT, supply 1000, precision 0.', 'rgb-lightning-node'],
    ['Send 1 QTWO to this RGB invoice: rgb:~/~/~/sig/any/1/utxob:test-recipient', 'rgb-lightning-node'],
    ['Create a Lightning invoice for 5000 sats.', 'rgb-lightning-node'],
    ["what's my balance?", 'rgb-lightning-node'],
    ['buy 500k sats of inbound liquidity', 'channel-manager'],
    ['unlock my node', 'kaleido-node'],
    ['pay lntbs10u1pexample with L-USDT', 'submarine-swaps'],
  ])('kaleido-mcp: %s → %s', (query, expected) => {
    expect(selectAvailableSkill(registry, query, mcpTools)?.name).toBe(expected);
  });

  it.each([
    ["what's my balance?", 'wallet-assistant'],
    ['what is my spark balance', 'spark-wallet'],
    ['swap 100k sats to USDB on flashnet', 'flashnet-swaps'],
    ['buy a $25 amazon gift card', 'bitrefill'],
    ['where can I spend sats in Turin', 'merchant-finder'],
  ])('in-app: %s → %s', (query, expected) => {
    expect(selectAvailableSkill(registry, query, inApp)?.name).toBe(expected);
  });
});
