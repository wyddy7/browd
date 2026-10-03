// Self-test for the runner's approval handling (#12). A scripted local model asks to take over a
// user tab; the runner must answer that approval (it rejects every action approval) right away,
// instead of the task waiting for the HITL controller's 5-minute timeout. No key, no spend.
//
//   pnpm build && node bench/om2w/selftest-hitl.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'browd-selftest-hitl-'));
const state = { asked: false, calls: [] };

const textOf = c =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : (p.text ?? ''))).join('\n') : '';

/** The scripted model: plan → take over the first user tab → after the refusal, finish (blocked). */
function decide(body) {
  const tools = (body.tools || []).map(t => t.function?.name).filter(Boolean);
  const forced = body.tool_choice?.function?.name ?? null;
  const schema = body.response_format?.json_schema?.name ?? null;
  const only = name => forced === name || schema === name || (tools.length === 1 && tools[0] === name);
  if (only('plan')) {
    return {
      tool: 'plan',
      args: {
        reasoning: 'The task refers to the tab the user already has open.',
        plan: ['Read the page the user has open'],
        taskParameters: { urls: [], queries: [], names: [] },
      },
    };
  }
  const finish = { intent: 'finish', outcome: 'blocked', response: 'The take-over of the open tab was refused.' };
  if (only('replan')) return { tool: 'replan', args: { decision: 'finish', plan: null, ...finish } };
  if (tools.includes('take_over_user_tab') && !state.asked) {
    const lastUser = [...(body.messages || [])].reverse().find(m => m.role === 'user');
    const id = /<user-tabs[^>]*>[\s\S]*?\{id: (\d+)/.exec(textOf(lastUser?.content))?.[1];
    if (id) {
      state.asked = true;
      return {
        tool: 'take_over_user_tab',
        args: { intent: 'read the open tab', tabId: Number(id), reason: 'the task says the page is already open' },
      };
    }
  }
  if (tools.includes('task_complete')) return { tool: 'task_complete', args: finish };
  return { text: 'ok' };
}

function reply(body, d) {
  const id = `chatcmpl-${state.calls.length}`;
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
  const call = d.tool ? [{ index: 0, id: `call_${state.calls.length}`, type: 'function', function: { name: d.tool, arguments: JSON.stringify(d.args) } }] : null;
  const asContent = !call || (body.response_format && !body.tools);
  const content = asContent ? (d.tool ? JSON.stringify(d.args) : d.text) : null;
  const finishReason = call && !asContent ? 'tool_calls' : 'stop';
  if (!body.stream) {
    const message = { role: 'assistant', content, ...(call && !asContent ? { tool_calls: call.map(({ index, ...c }) => c) } : {}) };
    return { json: { id, object: 'chat.completion', created: 0, model: 'scripted', choices: [{ index: 0, message, finish_reason: finishReason }], usage } };
  }
  const chunk = (delta, finish_reason = null, extra = {}) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: 'scripted', choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`;
  const parts = [chunk({ role: 'assistant', content: content ?? '' })];
  if (call && !asContent) parts.push(chunk({ tool_calls: call }));
  parts.push(chunk({}, finishReason), chunk({}, null, { choices: [], usage }), 'data: [DONE]\n\n');
  return { sse: parts.join('') };
}

const server = http.createServer((req, res) => {
  if (req.url === '/start') {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Start</title><h1>Start page</h1>');
    return;
  }
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'scripted' }] }));
    return;
  }
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const d = decide(body);
    state.calls.push(d.tool ?? 'text');
    const out = reply(body, d);
    if (out.json) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out.json));
    else res.writeHead(200, { 'content-type': 'text/event-stream' }).end(out.sse);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const t0 = Date.now();
const runner = spawn(
  process.execPath,
  [
    'run.mjs',
    '--task',
    'Summarise the page I already have open in my other tab.',
    '--url',
    `${base}/start`,
    '--llm-url',
    `${base}/v1`,
    '--max-steps',
    '8',
    '--timeout-min',
    '2',
    '--out',
    OUT,
  ],
  { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] },
);
runner.stdout.on('data', d => process.stdout.write(d));
runner.stderr.on('data', d => process.stderr.write(d));
await new Promise(r => runner.on('exit', r));
server.close();

const dir = fs.readdirSync(OUT).find(f => fs.existsSync(path.join(OUT, f, 'result.json')));
const result = dir ? JSON.parse(fs.readFileSync(path.join(OUT, dir, 'result.json'), 'utf8')) : null;
const asked = (result?.hitl ?? []).find(h => h.reason === 'take_over_request');
const ok = !!asked && asked.decision === 'reject' && !/cancel|timeout/.test(result.terminal_state) && result.seconds < 90;
console.log(
  `${ok ? 'PASS' : 'FAIL'} take_over_user_tab approval answered by the runner — ${JSON.stringify({
    modelCalls: state.calls,
    hitl: result?.hitl,
    terminal: result?.terminal_state,
    seconds: result?.seconds,
    wallSeconds: Math.round((Date.now() - t0) / 1000),
  })}`,
);
process.exit(ok ? 0 : 1);
