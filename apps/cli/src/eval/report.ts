/** Aggregate eval results → terminal bars + a standalone graphical HTML report + CSV. */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { c, bar, table } from '../ui.js';
import { MECHANISMS, type CaseResult, type Mechanism } from './run.js';
import { CATEGORIES, type Category } from './dataset.js';

export interface Cell {
  model: string;
  mech: Mechanism;
  applicable: number;
  pass: number;
  selection: number;
  args: number;
  overTrigger: number;
  avgLatency: number;
  pct: number; // pass / applicable * 100
}

export interface Aggregate {
  models: string[];
  cells: Cell[];
  byCategory: { model: string; mech: Mechanism; category: Category; pct: number }[];
}

const cellOf = (a: Aggregate, model: string, mech: Mechanism) => a.cells.find((x) => x.model === model && x.mech === mech);

export function aggregate(results: CaseResult[]): Aggregate {
  const models = [...new Set(results.map((r) => r.model))];
  const cells: Cell[] = [];
  for (const model of models) {
    for (const mech of MECHANISMS) {
      const rs = results.filter((r) => r.model === model && r.mechanism === mech && r.applicable);
      const applicable = rs.length;
      const pass = rs.filter((r) => r.pass).length;
      cells.push({
        model,
        mech,
        applicable,
        pass,
        selection: rs.filter((r) => r.selectionOk).length,
        args: rs.filter((r) => r.argsOk).length,
        overTrigger: results.filter((r) => r.model === model && r.mechanism === mech && r.overTriggered).length,
        avgLatency: applicable ? Math.round(rs.reduce((s, r) => s + r.latencyMs, 0) / applicable) : 0,
        pct: applicable ? Math.round((pass / applicable) * 100) : 0,
      });
    }
  }
  const byCategory: Aggregate['byCategory'] = [];
  for (const model of models)
    for (const mech of MECHANISMS)
      for (const category of CATEGORIES) {
        const rs = results.filter((r) => r.model === model && r.mechanism === mech && r.applicable && r.case.category === category);
        if (rs.length) byCategory.push({ model, mech, category, pct: Math.round((rs.filter((r) => r.pass).length / rs.length) * 100) });
      }
  return { models, cells, byCategory };
}

export function renderAnsi(a: Aggregate): string {
  const lines: string[] = [];
  for (const model of a.models) {
    lines.push(`\n${c.bold(model)}`);
    for (const mech of MECHANISMS) {
      const cell = cellOf(a, model, mech);
      if (!cell || !cell.applicable) continue;
      lines.push(`  ${c.dim(mech.padEnd(6))} ${bar(cell.pct, 20)}  ${c.dim(`${cell.pass}/${cell.applicable} · ${cell.avgLatency}ms${cell.overTrigger ? ` · ⚠${cell.overTrigger} over-trigger` : ''}`)}`);
    }
    // best mechanism for this model
    const best = MECHANISMS.map((m) => cellOf(a, model, m)).filter(Boolean).sort((x, y) => y!.pct - x!.pct)[0];
    if (best) lines.push(`  ${c.green('★ best:')} ${c.bold(best.mech)} (${best.pct}%)`);
  }
  return lines.join('\n');
}

const scoreColor = (p: number) => (p >= 80 ? '#39d353' : p >= 50 ? '#e3b341' : '#f85149');

interface ReportMeta { ts: number; dataset: number; mode: string; hardware: string; timing?: { totalMs: number; perModelLoadMs: Record<string, number> } }

function html(a: Aggregate, meta: ReportMeta): string {
  const date = new Date(meta.ts).toISOString().slice(0, 16).replace('T', ' ');
  const pctOf = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
  const matrixRows = a.models
    .map((model) => {
      const cells = MECHANISMS.map((mech) => {
        const cell = cellOf(a, model, mech);
        if (!cell || !cell.applicable) return `<td class="na">—</td>`;
        return `<td><div class="cell"><div class="bar"><i style="width:${cell.pct}%;background:${scoreColor(cell.pct)}"></i></div><span>${cell.pct}% <small class="frac">${cell.pass}/${cell.applicable}</small></span><small>sel ${pctOf(cell.selection, cell.applicable)}% · args ${pctOf(cell.args, cell.applicable)}% · ${cell.avgLatency}ms/turn${cell.overTrigger ? ` · ⚠${cell.overTrigger} over-trigger` : ''}</small></div></td>`;
      }).join('');
      const best = MECHANISMS.map((m) => cellOf(a, model, m)!).filter(Boolean).sort((x, y) => y.pct - x.pct)[0];
      return `<tr><th>${model}</th>${cells}<td class="best">${best ? `${best.mech} <b>${best.pct}%</b>` : ''}</td></tr>`;
    })
    .join('');

  const catModels = a.models;
  const catRows = catModels
    .map((model) => {
      const byMechBest = CATEGORIES.map((cat) => {
        const best = MECHANISMS.map((mech) => a.byCategory.find((x) => x.model === model && x.mech === mech && x.category === cat)).filter(Boolean).sort((x, y) => y!.pct - x!.pct)[0];
        return `<td>${best ? `<i style="background:${scoreColor(best.pct)}"></i>${best.pct}%` : '—'}</td>`;
      }).join('');
      return `<tr><th>${model}</th>${byMechBest}</tr>`;
    })
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>KaleidoMind — Tool-Use Eval</title>
<style>
  :root{color-scheme:dark}
  body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#0d1117;color:#e6edf3;margin:0;padding:32px;max-width:1000px;margin:auto}
  h1{font-size:22px;margin:0 0 4px}.sub{color:#8b949e;margin:0 0 24px}
  .grad{background:linear-gradient(90deg,#a371f7,#f778ba,#39d0d8);-webkit-background-clip:text;background-clip:text;color:transparent;font-weight:800}
  table{border-collapse:collapse;width:100%;margin:16px 0 32px}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #21262d;vertical-align:middle}
  thead th{color:#8b949e;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  tbody th{font-weight:700}
  .cell{display:flex;flex-direction:column;gap:2px;min-width:120px}
  .bar{height:8px;background:#21262d;border-radius:4px;overflow:hidden}
  .bar i{display:block;height:100%}
  .cell span{font-weight:700}.cell small{color:#8b949e;font-size:11px}
  td.na{color:#484f58}.best b{color:#39d353}
  td i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;vertical-align:middle}
  .meta{color:#8b949e;font-size:12px;border-top:1px solid #21262d;padding-top:16px;margin-top:24px}
  h2{font-size:15px;margin:24px 0 4px}
  .cell small.frac{font-weight:400;color:#8b949e}
  .gloss{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:6px 18px;font-size:13px}
  .gloss ul{margin:6px 0 12px;padding-left:18px;color:#c9d1d9}.gloss li{margin:3px 0}.gloss b{color:#e6edf3}
  .note{color:#8b949e;font-size:12px}
</style></head><body>
  <h1><span class="grad">KaleidoMind</span> · Tool-Use Eval</h1>
  <p class="sub">Which tool-use mechanism works best, per model — fully on-device via QVAC.</p>

  <h2>Task success — model × mechanism</h2>
  <table>
    <thead><tr><th>model</th>${MECHANISMS.map((m) => `<th>${m}</th>`).join('')}<th>best</th></tr></thead>
    <tbody>${matrixRows}</tbody>
  </table>

  <h2>Best mechanism by category</h2>
  <table>
    <thead><tr><th>model</th>${CATEGORIES.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
    <tbody>${catRows}</tbody>
  </table>

  ${meta.timing ? `<h2>Timing</h2><table><thead><tr><th>model</th><th>load time</th></tr></thead><tbody>${Object.entries(meta.timing.perModelLoadMs).map(([m, ms]) => `<tr><th>${m}</th><td>${(ms / 1000).toFixed(1)}s</td></tr>`).join('')}<tr><th>total run</th><td>${(meta.timing.totalMs / 1000).toFixed(1)}s</td></tr></tbody></table><p class="note">Per-turn latency (model thinking time) is shown in each matrix cell as <code>ms/turn</code>. Load time is one-off per model.</p>` : ''}

  <h2>How to read this</h2>
  <div class="gloss">
    <p><b>The question:</b> the same wallet capabilities are offered to each model four different ways. Higher = the model used that mechanism correctly more often.</p>
    <p><b>Mechanisms</b></p>
    <ul>
      <li><b>fc</b> — <i>function calling</i>: a few curated tool schemas. The clean baseline.</li>
      <li><b>mcp</b> — the same tools <i>plus ~46 decoys (≈60 total)</i>, like a real MCP server. Tests tool selection under a large surface.</li>
      <li><b>skill</b> — a skill first narrows the tools to ~3–9, then function calling (our progressive-disclosure default).</li>
      <li><b>cli</b> — no JSON: the model writes a shell command (<code>kaleido …</code>) via <code>run_command</code>. Only applies to actionable requests.</li>
    </ul>
    <p><b>Metrics</b> (per cell)</p>
    <ul>
      <li><b>%</b> — task success: the model did the right thing (selection ✓ <i>and</i> arguments ✓). The headline number.</li>
      <li><b>sel</b> — picked the right tool/command (ignoring arguments).</li>
      <li><b>args</b> — when it picked right, were the arguments correct (e.g. the amount to send).</li>
      <li><b>ms/turn</b> — average model thinking time per turn.</li>
      <li><b>⚠ over-trigger</b> — called a tool on a greeting/thanks (should have just replied). Lower is better.</li>
    </ul>
    <p><b>Categories</b>: wallet (balance/receive/send/channels/node), trading (price/quote), commerce (Bitrefill), knowledge (explain → search), memory (remember/recall), negative (greetings → must NOT call a tool).</p>
    <p class="note">Execution is <b>stubbed</b> (canned tool results) so results are reproducible and measure <i>model behaviour</i>, not wallet state. Same seeded dataset on every model/host.</p>
  </div>

  <div class="meta">${meta.dataset} cases · mode ${meta.mode} · ${meta.hardware} · ${date}</div>
</body></html>`;
}

/** Write raw.jsonl + matrix.csv + report.html into logs/eval-<ts>/. Returns the dir. */
export async function writeReport(
  baseDir: string,
  results: CaseResult[],
  a: Aggregate,
  meta: ReportMeta,
): Promise<string> {
  const dir = join(baseDir, `eval-${meta.ts}`);
  await mkdir(dir, { recursive: true });

  const raw = results
    .map((r) => JSON.stringify({ ts: meta.ts, model: r.model, mechanism: r.mechanism, id: r.case.id, intent: r.case.intent, category: r.case.category, prompt: r.case.prompt, expect: { skill: r.case.expectSkill, tool: r.case.expectTool, cli: r.case.expectCli }, got: { toolCalls: r.toolCalls, text: r.text, turns: r.turns, latencyMs: r.latencyMs }, grade: { applicable: r.applicable, selectionOk: r.selectionOk, argsOk: r.argsOk, skillOk: r.skillOk, overTriggered: r.overTriggered, pass: r.pass } }))
    .join('\n');
  await writeFile(join(dir, 'raw.jsonl'), raw + '\n');

  const csv = ['model,mechanism,applicable,pass,pct,selection,args,overTrigger,avgLatencyMs', ...a.cells.map((x) => `${x.model},${x.mech},${x.applicable},${x.pass},${x.pct},${x.selection},${x.args},${x.overTrigger},${x.avgLatency}`)].join('\n');
  await writeFile(join(dir, 'matrix.csv'), csv + '\n');

  // summary.json — what the web dashboard reads (matrix without the raw cases).
  await writeFile(join(dir, 'summary.json'), JSON.stringify({ meta, models: a.models, cells: a.cells, byCategory: a.byCategory }, null, 2));

  await writeFile(join(dir, 'report.html'), html(a, meta));
  return dir;
}

export function summaryTable(a: Aggregate): string {
  const rows: string[][] = [[c.dim('model'), ...MECHANISMS.map((m) => c.dim(m)), c.dim('best')]];
  for (const model of a.models) {
    const best = MECHANISMS.map((m) => cellOf(a, model, m)).filter(Boolean).sort((x, y) => y!.pct - x!.pct)[0];
    rows.push([model, ...MECHANISMS.map((m) => { const cell = cellOf(a, model, m); return cell && cell.applicable ? `${cell.pct}%` : '—'; }), best ? c.green(`${best.mech} ${best.pct}%`) : '—']);
  }
  return table(rows);
}
