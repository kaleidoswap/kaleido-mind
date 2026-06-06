/**
 * Simple local web dashboard for the eval tool — zero deps (node:http + a
 * vanilla-JS page). Browse runs, see the model×mechanism matrix + charts, drill
 * into individual cases, and kick off new runs (mock or real QVAC).
 *
 *   kaleido-mind serve [--port 4178]
 */

import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MIND_DIR } from '../config.js';
import { runEvalSuite, type EvalOpts } from './orchestrate.js';
import { c } from '../ui.js';

const LOGS = join(MIND_DIR, 'logs');

// Single in-flight run + structured live progress (polled by the dashboard).
let prog: { running: boolean; startedAt?: number; done: number; total: number; model?: string; mechanism?: string; phase?: string; message?: string } = { running: false, done: 0, total: 0 };

async function listRuns(): Promise<any[]> {
  let entries: string[] = [];
  try { entries = await readdir(LOGS); } catch { return []; }
  const runs: any[] = [];
  for (const e of entries.filter((x) => x.startsWith('eval-')).sort().reverse()) {
    try {
      const summary = JSON.parse(await readFile(join(LOGS, e, 'summary.json'), 'utf8'));
      runs.push({ id: e.replace('eval-', ''), dir: e, ...summary });
    } catch { /* skip incomplete */ }
  }
  return runs;
}

async function runCases(id: string): Promise<any[]> {
  const raw = await readFile(join(LOGS, `eval-${id}`, 'raw.jsonl'), 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function json(res: any, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

export async function serve(port = 4178): Promise<void> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(PAGE);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/runs') return json(res, 200, await listRuns());
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const elapsedMs = prog.startedAt ? Date.now() - prog.startedAt : 0;
        return json(res, 200, { ...prog, elapsedMs });
      }
      const m = url.pathname.match(/^\/api\/runs\/(\w+)$/);
      if (req.method === 'GET' && m) return json(res, 200, { cases: await runCases(m[1]!) });
      if (req.method === 'POST' && url.pathname === '/api/run') {
        if (prog.running) return json(res, 409, { error: 'a run is already in progress' });
        let body = '';
        for await (const chunk of req) body += chunk;
        const o = body ? JSON.parse(body) : {};
        const opts: EvalOpts = {
          mock: !!o.mock,
          models: o.models ? String(o.models).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
          mechanisms: o.mechanisms,
          per: o.per ? Number(o.per) : undefined,
          sample: o.sample ? Number(o.sample) : undefined,
          onProgress: (p) => { prog = { ...p }; },
        };
        prog = { running: true, startedAt: Date.now(), done: 0, total: 0, phase: 'starting', message: 'starting…' };
        // Fire-and-forget; the page polls /api/status + /api/runs.
        runEvalSuite(opts)
          .then((r) => { prog = { ...prog, running: false, phase: 'done', message: `done in ${(r.timing.totalMs / 1000).toFixed(1)}s` }; })
          .catch((e) => { prog = { ...prog, running: false, phase: 'error', message: `error: ${e.message}` }; });
        return json(res, 202, { started: true });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });
  await new Promise<void>((r) => server.listen(port, r));
  console.log(`\n${c.violet('◆')} KaleidoMind eval dashboard → ${c.bold(`http://localhost:${port}`)}`);
  console.log(c.dim('  browse runs, see the matrix, trigger runs · Ctrl-C to stop\n'));
  await new Promise<never>(() => {}); // keep alive
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>KaleidoMind Eval</title>
<style>
 :root{color-scheme:dark}*{box-sizing:border-box}
 body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#0d1117;color:#e6edf3;margin:0;padding:24px;max-width:1100px;margin:auto}
 h1{font-size:22px;margin:0 0 2px}.grad{background:linear-gradient(90deg,#a371f7,#f778ba,#39d0d8);-webkit-background-clip:text;background-clip:text;color:transparent;font-weight:800}
 .sub{color:#8b949e;margin:0 0 20px}
 .panel{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:16px;margin-bottom:20px}
 label{color:#8b949e;font-size:12px;margin-right:6px}
 input,select{background:#0d1117;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:6px 8px;font:inherit}
 button{background:#a371f7;border:0;color:#0d1117;font-weight:700;border-radius:6px;padding:7px 14px;cursor:pointer}
 button:disabled{opacity:.5;cursor:default}
 table{border-collapse:collapse;width:100%;margin-top:8px}
 th,td{padding:7px 9px;text-align:left;border-bottom:1px solid #21262d;vertical-align:middle}
 thead th{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
 .bar{height:8px;background:#21262d;border-radius:4px;overflow:hidden;min-width:90px}.bar i{display:block;height:100%}
 .cellv{font-weight:700}.small{color:#8b949e;font-size:11px}
 .pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:700}
 .ok{background:#2ea04333;color:#3fb950}.no{background:#f8514933;color:#f85149}
 .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
 code{background:#21262d;padding:1px 5px;border-radius:4px;font-size:12px}
 .muted{color:#8b949e}
 .prog{margin-top:12px;display:none}.pbar{height:10px;background:#21262d;border-radius:5px;overflow:hidden}.pbar i{display:block;height:100%;background:linear-gradient(90deg,#a371f7,#f778ba);width:0%;transition:width .3s}
 .ptext{font-size:12px;color:#8b949e;margin-top:4px;display:block}
 details{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:8px 16px;margin-bottom:20px}
 summary{cursor:pointer;color:#a371f7;font-weight:600}.gl{font-size:13px}.gl b{color:#e6edf3}.gl ul{padding-left:18px}.gl li{margin:3px 0;color:#c9d1d9}
 .csmall{display:block;color:#8b949e;font-size:11px}.frac{color:#8b949e;font-weight:400}
 .timing{font-size:12px;color:#8b949e;margin-top:10px}
</style></head><body>
 <h1><span class="grad">KaleidoMind</span> · Eval</h1>
 <p class="sub">Which tool-use mechanism works best, per model — fully on-device via QVAC.</p>

 <div class="panel">
   <div class="row">
     <span><label>models</label><input id="models" placeholder="qwen3-0.6b,qwen3-4b" size="26"></span>
     <span><label>per</label><input id="per" type="number" value="2" style="width:54px"></span>
     <span><label>sample</label><input id="sample" type="number" placeholder="all" style="width:60px"></span>
     <span><label><input type="checkbox" id="mock"> mock</label></span>
     <button id="run">Run eval</button>
     <span id="status" class="muted"></span>
   </div>
   <div class="small" style="margin-top:6px">mechanisms: <code>fc</code> curated · <code>mcp</code> ~60 tools · <code>skill</code> scoped · <code>cli</code> command · leave models blank to use installed.</div>
   <div class="prog" id="prog"><div class="pbar"><i id="pbar"></i></div><span class="ptext" id="ptext"></span></div>
 </div>

 <details>
   <summary>How to read this — mechanisms &amp; metrics</summary>
   <div class="gl">
     <p><b>The question:</b> the same wallet capabilities are offered four ways; higher = the model used that mechanism correctly more often. Execution is stubbed so we measure <i>model behaviour</i>, reproducibly.</p>
     <ul>
       <li><b>fc</b> — function calling with a few curated tools (baseline).</li>
       <li><b>mcp</b> — same tools + ~46 decoys (≈60), like a real MCP server: selection under a large surface.</li>
       <li><b>skill</b> — a skill narrows tools to ~3–9, then function calling (our default).</li>
       <li><b>cli</b> — the model writes a <code>kaleido …</code> command instead of JSON (actionable requests only).</li>
     </ul>
     <ul>
       <li><b>%</b> = task success: right tool <i>and</i> right arguments. <b>sel</b> = right tool. <b>args</b> = right arguments. <b>ms/turn</b> = thinking time. <b>⚠</b> = called a tool on a greeting (over-trigger, lower is better).</li>
     </ul>
   </div>
 </details>

 <div class="panel">
   <div class="row"><label>run</label><select id="runsel"></select><span id="meta" class="muted"></span></div>
   <div id="matrix"></div>
   <div class="timing" id="timing"></div>
 </div>

 <div class="panel">
   <div class="row">
     <strong>Cases</strong>
     <select id="fmodel"><option value="">all models</option></select>
     <select id="fmech"><option value="">all mechanisms</option><option>fc</option><option>mcp</option><option>skill</option><option>cli</option></select>
     <select id="fstatus"><option value="">all</option><option value="pass">pass</option><option value="fail">fail</option></select>
   </div>
   <div id="cases"></div>
 </div>

<script>
const MECHS=['fc','mcp','skill','cli'];
const col=p=>p>=80?'#39d353':p>=50?'#e3b341':'#f85149';
const pctOf=(n,d)=>d?Math.round(n/d*100):0;
const SPIN='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';let si=0;
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
const $=s=>document.querySelector(s);
let RUNS=[], CASES=[];

async function loadRuns(){
  RUNS=await (await fetch('/api/runs')).json();
  const sel=$('#runsel'); sel.innerHTML='';
  RUNS.forEach(r=>{const o=document.createElement('option');o.value=r.id;
    o.textContent=new Date(Number(r.id)).toLocaleString()+' · '+r.meta.mode+' · '+r.models.join(',');sel.appendChild(o);});
  if(RUNS.length){sel.value=RUNS[0].id; selectRun(RUNS[0].id);} else { $('#matrix').innerHTML='<p class="muted">No runs yet — run one above.</p>'; }
}
const findRun=id=>RUNS.find(r=>r.id===id);
function renderMatrix(run){
  const cell=(m,me)=>run.cells.find(c=>c.model===m&&c.mech===me);
  let h='<table><thead><tr><th>model</th>'+MECHS.map(m=>'<th>'+m+'</th>').join('')+'<th>best</th></tr></thead><tbody>';
  run.models.forEach(m=>{
    let best=null; MECHS.forEach(me=>{const c=cell(m,me);if(c&&c.applicable&&(!best||c.pct>best.pct))best=c;});
    h+='<tr><th>'+esc(m)+'</th>'+MECHS.map(me=>{const c=cell(m,me);
      if(!c||!c.applicable)return '<td class="muted">—</td>';
      return '<td><div class="bar"><i style="width:'+c.pct+'%;background:'+col(c.pct)+'"></i></div><span class="cellv">'+c.pct+'%</span> <span class="frac">'+c.pass+'/'+c.applicable+'</span><span class="csmall">sel '+pctOf(c.selection,c.applicable)+'% · args '+pctOf(c.args,c.applicable)+'% · '+c.avgLatency+'ms/turn'+(c.overTrigger?' · ⚠'+c.overTrigger:'')+'</span></td>';
    }).join('')+'<td>'+(best?esc(best.mech)+' <b style="color:'+col(best.pct)+'">'+best.pct+'%</b>':'')+'</td></tr>';
  });
  $('#matrix').innerHTML=h+'</tbody></table>';
  $('#meta').textContent=run.meta.dataset+' cases · '+run.meta.mode+' · '+run.meta.hardware;
  const t=run.meta.timing;
  $('#timing').innerHTML=t?('⏱ total '+(t.totalMs/1000).toFixed(1)+'s · load: '+Object.entries(t.perModelLoadMs).map(([m,ms])=>esc(m)+' '+(ms/1000).toFixed(1)+'s').join(' · ')):'';
  $('#fmodel').innerHTML='<option value="">all models</option>'+run.models.map(m=>'<option>'+esc(m)+'</option>').join('');
}
async function selectRun(id){
  const run=findRun(id); if(!run)return; renderMatrix(run);
  CASES=(await (await fetch('/api/runs/'+id)).json()).cases; renderCases();
}
function renderCases(){
  const fm=$('#fmodel').value,fe=$('#fmech').value,fs=$('#fstatus').value;
  const rows=CASES.filter(c=>(!fm||c.model===fm)&&(!fe||c.mechanism===fe)&&(!fs||(fs==='pass'?c.grade.pass:!c.grade.pass)));
  let h='<table><thead><tr><th>✓</th><th>model</th><th>mech</th><th>prompt</th><th>expected</th><th>got</th><th>ms</th></tr></thead><tbody>';
  rows.slice(0,400).forEach(c=>{
    const exp=c.expect.tool===null?'(no tool)':(c.expect.tool||c.expect.cli||c.expect.skill||'—');
    const got=(c.got.toolCalls||[]).map(t=>t.name).join(', ')||(c.got.text?('"'+c.got.text.slice(0,40)+'"'):'∅');
    h+='<tr><td><span class="pill '+(c.grade.pass?'ok':'no')+'">'+(c.grade.pass?'pass':'fail')+'</span></td><td>'+esc(c.model)+'</td><td>'+esc(c.mechanism)+'</td><td>'+esc(c.prompt)+'</td><td><code>'+esc(exp)+'</code></td><td><code>'+esc(got)+'</code></td><td class="small">'+Math.round(c.got.latencyMs||0)+'</td></tr>';
  });
  $('#cases').innerHTML=h+'</tbody></table>'+(rows.length>400?'<p class="small">showing 400 of '+rows.length+'</p>':'');
}
$('#runsel').onchange=e=>selectRun(e.target.value);
['#fmodel','#fmech','#fstatus'].forEach(s=>$(s).onchange=renderCases);
$('#run').onclick=async()=>{
  $('#run').disabled=true;
  await fetch('/api/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    mock:$('#mock').checked, models:$('#models').value, per:$('#per').value, sample:$('#sample').value||undefined})});
  poll();
};
async function poll(){
  const s=await (await fetch('/api/status')).json();
  const prog=$('#prog'), bar=$('#pbar'), ptext=$('#ptext');
  if(s.running){
    prog.style.display='block';
    const pct=s.total?Math.round(s.done/s.total*100):0;
    bar.style.width=pct+'%';
    const el=Math.round((s.elapsedMs||0)/1000);
    const eta=s.done>0?Math.round(el/s.done*(s.total-s.done)):0;
    ptext.textContent=SPIN[si++%SPIN.length]+' '+(s.phase==='loading'?'⤓ loading model… ':'')+(s.message||((s.model||'')+' · '+(s.mechanism||'')+' · '+s.done+'/'+s.total+' ('+pct+'%)'))+' · '+el+'s elapsed'+(eta?' · ETA '+eta+'s':'');
    $('#status').textContent='';
    setTimeout(poll,1000);
  } else {
    bar.style.width='100%';
    $('#run').disabled=false;
    $('#status').textContent=s.message?('✓ '+s.message):'';
    ptext.textContent=s.message||'';
    setTimeout(()=>{prog.style.display='none';},2500);
    loadRuns();
  }
}
loadRuns();
</script></body></html>`;
