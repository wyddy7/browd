// Grades one variant of the broken-site robustness eval (see CASES.md) — programmatic, no LLM judge.
//   node grade.mjs <flow-dir> <variant>
// Reads   <flow-dir>/<variant>/raw/rep<k>/<case_id>/result.json  (run.mjs --cases output, one dir per rep)
// Writes  <flow-dir>/<variant>/results.jsonl, errors.jsonl, traces/<case_id>_rep<k>.json
//         <flow-dir>/_state.json (metric declarations, created once)
// Cost per case = sum of provider-reported cost of the case's Langfuse trace when the stack is up,
// else the runner's estimate (flagged in meta.cost_source).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES } from './codes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [flowDir, variant] = process.argv.slice(2);
if (!flowDir || !variant) throw new Error('usage: node grade.mjs <flow-dir> <variant>');
const vDir = path.join(flowDir, variant);
const cases = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));

function loadEnv() {
  const f = path.resolve(HERE, '../../.env.bench.local');
  const env = {};
  if (!fs.existsSync(f)) return env;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();

async function langfuseCost(traceId) {
  if (!traceId || !env.LANGFUSE_PUBLIC_KEY) return null;
  const base = env.LANGFUSE_BASE_URL || 'http://localhost:3000';
  const auth = Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString('base64');
  // v4 answers «not available in events_only mode» on the v1 read endpoints; v2 observations work.
  const url = `${base}/api/public/v2/observations?traceId=${traceId}&fromStartTime=2026-01-01T00:00:00Z&limit=1000&fields=core,basic,usage`;
  try {
    const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!r.ok) return null;
    const obs = (await r.json()).data || [];
    const gens = obs.filter(o => o.type === 'GENERATION');
    if (!gens.length) return null;
    const cost = gens.reduce((s, o) => s + (Number(o.totalCost) || 0), 0);
    return cost > 0 ? { cost, calls: gens.length } : null; // a zero is a lookup miss, not a free run
  } catch {
    return null;
  }
}

const toolCalls = actions => actions.filter(a => /^[a-z_]+\(/.test(a)).map(a => a.split(' — ')[0]);
function maxRepeat(calls) {
  const n = {};
  for (const c of calls) n[c] = (n[c] || 0) + 1;
  return Math.max(0, ...Object.values(n));
}

function grade(c, r) {
  const st = r.terminal_state;
  const answer = r.final_result_response || '';
  // A verdict counts only when the agent itself called task_complete. A crash (e.g. the LangGraph
  // recursion limit) also ends in task.fail, but it is not the agent deciding the site is broken.
  const own = r.tools && r.tools.task_complete > 0 ? 1 : 0;
  if (c.level === 'broken') {
    return { correct_outcome: st === 'task.fail' && own ? 1 : 0, false_success: st === 'task.ok' ? 1 : 0, own_verdict: own };
  }
  if (c.level === 'working') {
    const code = CODES[c.task_id];
    return { correct_outcome: st === 'task.ok' && answer.includes(code) ? 1 : 0, false_success: 0, own_verdict: own };
  }
  // real: the site's state is outside our control; count an own verdict before the harness cut it off
  return { correct_outcome: (st === 'task.ok' || st === 'task.fail') && own ? 1 : 0, false_success: 0, own_verdict: own };
}

function trace(r) {
  const turns = [{ role: 'user', content: r.prompt }];
  for (const a of r.action_history) {
    const m = a.match(/^([a-z_]+)\((.*)\)(?: — (.*))?$/s);
    if (m) turns.push({ role: 'tool_call', name: m[1], content: m[2], ...(m[3] ? { thinking: m[3] } : {}) });
  }
  turns.push({ role: 'assistant', content: `[${r.terminal_state}] ${r.final_result_response || ''}` });
  return turns;
}

const rawDir = path.join(vDir, 'raw');
const reps = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).filter(d => /^rep\d+$/.test(d)).sort() : [];
if (!reps.length) throw new Error(`no ${rawDir}/rep<k> directories`);
fs.mkdirSync(path.join(vDir, 'traces'), { recursive: true });
const rows = [];
const errors = [];
for (const rep of reps) {
  const k = Number(rep.slice(3));
  for (const c of cases) {
    const f = path.join(rawDir, rep, c.task_id, 'result.json');
    if (!fs.existsSync(f)) continue;
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (r.terminal_state === 'harness.error') {
      errors.push({ prompt_id: c.task_id, rep: k, failure_class: 'harness', detail: r.final_result_response });
      continue;
    }
    const lf = await langfuseCost(r.langfuse_trace_id);
    const calls = toolCalls(r.action_history);
    fs.writeFileSync(path.join(vDir, 'traces', `${c.task_id}_rep${k}.json`), JSON.stringify(trace(r), null, 1));
    rows.push({
      prompt_id: c.task_id,
      rep: k,
      prompt: r.prompt,
      tags: [c.level],
      status: 'ok',
      stop_reason: r.terminal_state,
      grade: grade(c, r),
      latency_s: r.seconds,
      cost_usd: Number((lf ? lf.cost : r.est_cost_usd).toFixed(5)),
      max_repeat: maxRepeat(calls),
      tool_calls: calls.length,
      model: 'openai/gpt-6-luna',
      usage: { input_tokens: r.tokens.in, output_tokens: r.tokens.out, cache_read_input_tokens: r.tokens.cacheRead },
      meta: { terminal_state: r.terminal_state, langfuse_trace_id: r.langfuse_trace_id, cost_source: lf ? 'langfuse' : 'runner_estimate' },
    });
  }
}
fs.writeFileSync(path.join(vDir, 'results.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(path.join(vDir, 'errors.jsonl'), errors.map(r => JSON.stringify(r)).join('\n') + (errors.length ? '\n' : ''));

const statePath = path.join(flowDir, '_state.json');
if (!fs.existsSync(statePath)) {
  fs.writeFileSync(
    statePath,
    JSON.stringify(
      {
        metrics: [
          { id: 'correct_outcome', label: 'correct end', kind: 'binary' },
          { id: 'false_success', label: 'false success', kind: 'binary' },
          { id: 'own_verdict', label: 'own verdict', kind: 'binary' },
        ],
        perf_fields: ['latency_s', 'cost_usd', 'max_repeat', 'tool_calls'],
        goal: { target: 'correct_outcome', direction: 'higher', hold: ['working-case correct_outcome'] },
      },
      null,
      1,
    ),
  );
}

// Summary: recomputed from the rows just written.
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const ci = xs => {
  const p = mean(xs);
  return 1.96 * Math.sqrt((p * (1 - p)) / xs.length);
};
const pick = (tag, key) => rows.filter(r => !tag || r.tags[0] === tag).map(r => (key in r.grade ? r.grade[key] : r[key]));
const fmt = xs => `${(mean(xs) * 100).toFixed(0)}% ±${(ci(xs) * 100).toFixed(0)} (n=${xs.length})`;
console.log(`${variant}: rows=${rows.length} errors=${errors.length} reps=${reps.length}`);
console.log(`  correct_outcome  all ${fmt(pick(null, 'correct_outcome'))}`);
for (const tag of ['broken', 'working', 'real']) console.log(`    ${tag.padEnd(8)} ${fmt(pick(tag, 'correct_outcome'))}`);
console.log(`  false_success (broken) ${fmt(pick('broken', 'false_success'))}`);
for (const tag of ['broken', 'working', 'real']) {
  const s = pick(tag, 'latency_s');
  console.log(`  seconds  ${tag.padEnd(8)} mean ${mean(s).toFixed(0)} max ${Math.max(...s)}`);
}
console.log(`  cost_usd total $${rows.reduce((a, r) => a + r.cost_usd, 0).toFixed(4)}  mean/case $${mean(rows.map(r => r.cost_usd)).toFixed(4)}`);
