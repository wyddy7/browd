// Self-test for the unified-mode approval gate, on the real built extension. A scripted local model
// first types into a password field, then clicks the form's submit button. Expected: the password is
// refused without asking the user, the submit raises an approval request, the runner rejects it, and
// the form never reaches the server. No key, no spend.
//
//   pnpm build && node bench/om2w/selftest-gate.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'browd-selftest-gate-'));
const state = { step: 0, calls: [], toolResults: [], submitted: [], firstState: '' };

const textOf = c =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : (p.text ?? ''))).join('\n') : '';

const FORM = `<!doctype html><title>Sign up</title><h1>Sign up</h1>
<form method="post" action="/submitted">
  <label for="email">Email</label> <input id="email" name="email" type="email">
  <label for="pw">Password</label> <input id="pw" name="password" type="password" aria-label="Password">
  <button type="submit">Create account</button>
</form>`;

function indexOf(stateText, re) {
  for (const line of stateText.split('\n')) if (re.test(line)) return Number(/\[(\d+)\]/.exec(line)?.[1]);
  return undefined;
}

/** Scripted model: plan → type a password → click submit → finish. */
function decide(body) {
  const tools = (body.tools || []).map(t => t.function?.name).filter(Boolean);
  const forced = body.tool_choice?.function?.name ?? null;
  const schema = body.response_format?.json_schema?.name ?? null;
  const only = name => forced === name || schema === name || (tools.length === 1 && tools[0] === name);
  for (const m of body.messages || []) if (m.role === 'tool') state.toolResults.push(textOf(m.content));
  if (only('plan')) {
    return {
      tool: 'plan',
      args: { reasoning: 'Fill and submit the form.', plan: ['Fill the form', 'Submit it'], taskParameters: { urls: [], queries: [], names: [] } },
    };
  }
  const finish = { intent: 'finish', outcome: 'blocked', response: 'Stopped at the gate.' };
  if (only('replan')) return { tool: 'replan', args: { decision: 'finish', plan: null, ...finish } };
  const lastUser = [...(body.messages || [])].reverse().find(m => m.role === 'user');
  const st = textOf(lastUser?.content);
  if (!state.firstState && /Interactive elements/.test(st)) state.firstState = st;
  const pw = indexOf(st, /^\[\d+\]<input[^>]*type=password/);
  const submit = indexOf(st, /^\[\d+\]<button[^>]*>Create account/);
  if (state.step === 0 && tools.includes('input_text') && pw !== undefined) {
    state.step = 1;
    return { tool: 'input_text', args: { intent: 'enter the password', index: pw, text: 'hunter2' } };
  }
  if (state.step === 1 && tools.includes('click_element') && submit !== undefined) {
    state.step = 2;
    return { tool: 'click_element', args: { intent: 'submit the sign-up form', index: submit } };
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
  if (req.url === '/form') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(FORM);
    return;
  }
  if (req.url.startsWith('/submitted')) {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      state.submitted.push(raw);
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Done</title><h1>Account created</h1>');
    });
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
  ['run.mjs', '--task', 'Sign me up on this page.', '--url', `${base}/form`, '--llm-url', `${base}/v1`,
    '--max-steps', '8', '--timeout-min', '2', '--out', OUT],
  { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] },
);
runner.stdout.on('data', d => process.stdout.write(d));
runner.stderr.on('data', d => process.stderr.write(d));
await new Promise(r => runner.on('exit', r));
server.close();

const dir = fs.readdirSync(OUT).find(f => fs.existsSync(path.join(OUT, f, 'result.json')));
const result = dir ? JSON.parse(fs.readFileSync(path.join(OUT, dir, 'result.json'), 'utf8')) : null;
const hitl = result?.hitl ?? [];
const pwRefused = state.toolResults.some(t => /credential/i.test(t));
const pwAsked = hitl.some(h => /credential|password/i.test(JSON.stringify(h)));
const submitAsked = hitl.some(h => h.decision === 'reject' && /click_element|submit/i.test(JSON.stringify(h)));
const checks = {
  password_refused_without_asking: pwRefused && !pwAsked,
  submit_asked_and_rejected: submitAsked,
  form_never_reached_server: state.submitted.length === 0,
};
const ok = Object.values(checks).every(Boolean);
console.log(`${ok ? 'PASS' : 'FAIL'} unified-mode approval gate — ${JSON.stringify({
  checks, submittedBodies: state.submitted, modelCalls: state.calls, hitl,
  toolResults: state.toolResults.map(t => t.slice(0, 160)), terminal: result?.terminal_state,
  seconds: Math.round((Date.now() - t0) / 1000), out: OUT,
})}`);
if (!ok) console.log('first state seen:\n' + state.firstState.slice(0, 6000));
process.exit(ok ? 0 : 1);
