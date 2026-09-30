// Online-Mind2Web runner for Browd: loads the built extension (../../dist) into
// Playwright Chromium, configures it through chrome.storage, drives one task per
// fresh profile through the side-panel port, and writes WebJudge-format output:
//   <out>/<task_id>/result.json + trajectory/<n>.png
// Usage: node run.mjs [--only id1,id2 (full ids or 8-char prefixes)] [--limit N] [--max-steps 30]
//                     [--timeout-min 8] [--budget 3.5] [--out dir] [--headless]
//        node run.mjs --task "<any task>" --url <start url>   # ad-hoc manual-QA replacement, no judge needed
//        node run.mjs --cases <file.json> [--host-rules "MAP *.test 127.0.0.1:8765"] [--before-each <url>]
//          # own task list (same fields as subset30.json); host rules go to Chromium verbatim;
//          # --before-each is fetched before every task (e.g. a fixture server's state reset)
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const EXT = path.join(ROOT, 'dist');
const PRICE = { in: 0.1, cached: 0.01, out: 0.5 }; // $ per 1M tokens, openai/gpt-6-luna (OpenRouter, 2026-09)

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const OUT = path.resolve(HERE, arg('out', `../../bench-runs/om2w-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const MAX_STEPS = Number(arg('max-steps', 30));
const TIMEOUT_MS = Number(arg('timeout-min', 8)) * 60_000;
const BUDGET = Number(arg('budget', 3.5));
// Headless by default so no window steals focus / switches macOS Spaces. The full Chromium build
// (channel 'chromium') runs new headless, which loads extensions; --headed shows a window, which
// some anti-bot walls treat more kindly (the 2026-09-27 benchmark ran headed).
const HEADLESS = !arg('headed', false);
// as-shipped = benchmark task text verbatim; site = one sentence naming the start site (the usual OM2W harness setup)
const MODE = arg('mode', 'as-shipped');
const SW_LOG = Boolean(arg('sw-log', false)); // capture the extension service-worker console via CDP (debug runs)
const HOST_RULES = arg('host-rules', null);
const BEFORE_EACH = arg('before-each', null);
let swPort = 9333;
const taskText = t =>
  MODE === 'site' ? `${t.confirmed_task}\n\nStart at ${t.website} (already open in your tab) and complete the task on that website.` : t.confirmed_task;

function loadEnv() {
  const f = path.join(ROOT, '.env.bench.local');
  const env = {};
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing in .env.bench.local');
  return { key: env.OPENROUTER_API_KEY, model: env.BENCH_MODEL || 'openai/gpt-6-luna' };
}

async function keyUsage(key) {
  const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` } });
  const d = (await r.json()).data;
  return d.usage;
}

function storageConfig(key, model) {
  return {
    'llm-api-keys': {
      providers: {
        openrouter: {
          apiKey: key,
          name: 'OpenRouter',
          type: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          modelNames: [model],
          createdAt: Date.now(),
        },
      },
    },
    'agent-models': {
      agents: {
        planner: { provider: 'openrouter', modelName: model },
        navigator: { provider: 'openrouter', modelName: model },
      },
    },
    // Keep Google out: repeated automated searches from one IP trip its captcha wall.
    'firewall-settings': { allowList: [], denyList: ['google.com'], enabled: true },
    // Shipped defaults (packages/storage/lib/settings/generalSettings.ts) except maxSteps.
    'general-settings': {
      maxSteps: MAX_STEPS,
      maxActionsPerStep: 5,
      maxFailures: 3,
      useVision: false,
      useVisionForPlanner: false,
      planningInterval: 3,
      displayHighlights: true,
      minWaitPageLoad: 250,
      replayHistoricalTasks: false,
      launchShortcut: 'Ctrl+E',
      agentMode: 'unified',
      visionMode: 'on',
      permissionMode: 'default',
      appearanceTheme: 'light',
      interfaceLanguage: 'system',
    },
  };
}

const TERMINAL = new Set(['task.ok', 'task.fail', 'task.cancel']);
const SHOT_ON = new Set(['act.ok', 'act.fail', 'step.ok', 'step.fail']);

async function runTask(task, env) {
  const dir = path.join(OUT, task.task_id);
  const traj = path.join(dir, 'trajectory');
  fs.mkdirSync(traj, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browd-bench-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: HEADLESS,
    channel: 'chromium',
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--window-position=2600,0',
      ...(HOST_RULES ? [`--host-resolver-rules=${HOST_RULES}`] : []),
      ...(SW_LOG ? [`--remote-debugging-port=${++swPort}`] : []),
    ],
  });
  const log = [];
  const actions = [];
  const hitl = [];
  const tools = {};
  let lastPlan = [];
  const usage = { in: 0, out: 0, cacheRead: 0 };
  let shot = 0;
  let final = { state: 'harness.error', details: '' };
  const t0 = Date.now();
  try {
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 30_000 }));
    const extId = new URL(sw.url()).host;
    if (SW_LOG) {
      // Plain CDP over WebSocket to the extension worker target; Node 22 ships a global WebSocket.
      const list = await (await fetch(`http://127.0.0.1:${swPort}/json/list`)).json();
      const target = list.find(x => x.type === 'service_worker' && x.url.includes(extId));
      const swLog = fs.createWriteStream(path.join(dir, 'sw-console.log'));
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
      ws.onmessage = m => {
        const msg = JSON.parse(m.data);
        if (msg.method === 'Runtime.consoleAPICalled') {
          const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ');
          swLog.write(`${Date.now() - t0}\t${msg.params.type}\t${String(text).slice(0, 600)}\n`);
        } else if (msg.method === 'Runtime.exceptionThrown') {
          swLog.write(`${Date.now() - t0}\texception\t${JSON.stringify(msg.params.exceptionDetails).slice(0, 600)}\n`);
        }
      };
    }
    // chrome.storage is not reachable from the worker handle here; write it from an extension page.
    const setup = await ctx.newPage();
    await setup.goto(`chrome-extension://${extId}/side-panel/index.html`);
    await setup.evaluate(async cfg => chrome.storage.local.set(cfg), storageConfig(env.key, env.model));
    await setup.close();

    const target = ctx.pages()[0] || (await ctx.newPage());
    try {
      await target.goto(task.website, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    } catch (e) {
      log.push({ t: Date.now() - t0, harness: `goto failed: ${e.message.split('\n')[0]}` });
    }

    const panel = await ctx.newPage();
    await panel.addInitScript(() => {
      window.__ev = [];
      window.__hitl = [];
      const orig = chrome.runtime.connect.bind(chrome.runtime);
      chrome.runtime.connect = (...a) => {
        const p = orig(...a);
        if (a[0] && a[0].name === 'side-panel-connection') {
          window.__port = p;
          p.onMessage.addListener(m => window.__ev.push(m));
        }
        return p;
      };
      chrome.runtime.onMessage.addListener(msg => {
        if (msg && msg.type === 'browd:hitl:request') window.__hitl.push(msg.payload);
      });
    });
    await panel.goto(`chrome-extension://${extId}/side-panel/index.html`);
    await panel.waitForTimeout(2500);
    await panel.evaluate(() => {
      if (!window.__port) chrome.runtime.connect({ name: 'side-panel-connection' });
    });

    await target.bringToFront();
    const tabId = await panel.evaluate(async url => {
      const tabs = await chrome.tabs.query({});
      const hit = tabs.find(t => t.url === url) || tabs.find(t => !t.url.startsWith('chrome-extension://'));
      return hit && hit.id;
    }, target.url());
    await panel.evaluate(
      ({ task, tabId }) =>
        window.__port.postMessage({ type: 'new_task', task, taskId: crypto.randomUUID(), tabId, priorMessages: [] }),
      { task: taskText(task), tabId },
    );

    const snap = async label => {
      const activeUrl = await panel.evaluate(async () => {
        const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return t && t.url;
      });
      const pages = ctx.pages().filter(p => !p.url().startsWith('chrome-extension://'));
      const page = pages.find(p => p.url() === activeUrl) || pages[pages.length - 1];
      if (!page) return;
      const file = `${shot++}.png`;
      try {
        await page.screenshot({ path: path.join(traj, file), timeout: 15_000 });
        log.push({ t: Date.now() - t0, shot: file, label, url: page.url() });
      } catch (e) {
        shot--;
        log.push({ t: Date.now() - t0, harness: `screenshot failed: ${e.message.split('\n')[0]}` });
      }
    };
    await snap('start');

    let cancelled = false;
    while (true) {
      await panel.waitForTimeout(1500);
      const [evs, asks] = await panel.evaluate(() => [window.__ev.splice(0), window.__hitl.splice(0)]);
      for (const h of asks) {
        const decision =
          h.reason === 'ambiguous_input'
            ? {
                type: 'answer',
                answer:
                  'No further input is available. Use your best judgment with what is on the page. Do not submit forms, purchases or bookings.',
              }
            : {
                type: 'reject',
                message: 'Automated benchmark run: this action is not allowed. Stop here and report what you found.',
              };
        hitl.push({ reason: h.reason, pendingAction: h.pendingAction, decision: decision.type });
        await panel.evaluate(({ id, decision }) => window.__port.postMessage({ type: 'hitl_decision', id, decision }), {
          id: h.id,
          decision,
        });
      }
      let done = false;
      for (const m of evs) {
        if (m.type !== 'execution') {
          log.push({ t: Date.now() - t0, msg: m });
          continue;
        }
        const details = m.data && m.data.details;
        log.push({ t: Date.now() - t0, actor: m.actor, state: m.state, step: m.data && m.data.step, details });
        if (m.state === 'step.ok' && typeof details === 'string' && details.startsWith('{"type":"plan"')) {
          try {
            const items = JSON.parse(details).items || [];
            if (items.length) lastPlan = items; // the terminal event retires the plan with []
          } catch {}
        }
        if (m.state === 'task.usage') {
          try {
            const u = JSON.parse(details);
            usage.in += u.inputTokens || 0;
            usage.out += u.outputTokens || 0;
            usage.cacheRead += u.cacheReadTokens || 0;
          } catch {}
        }
        if (m.state === 'act.start' && details) actions.push(String(details));
        if (m.state === 'step.trace' && details) {
          try {
            const s = JSON.parse(details).structured;
            if (s && s.tool && s.tool !== 'llm_call') {
              let a = {};
              try {
                a = JSON.parse(s.args);
              } catch {}
              const { intent, ...rest } = a;
              actions.push(`${s.tool}(${JSON.stringify(rest).slice(0, 200)})${intent ? ` — ${intent}` : ''}`);
              tools[s.tool] = (tools[s.tool] || 0) + 1;
            }
          } catch {}
        }
        if (SHOT_ON.has(m.state)) await snap(m.state);
        if (TERMINAL.has(m.state)) {
          final = { state: m.state, details: details || '' };
          done = true;
        }
      }
      if (done) {
        await snap('final');
        break;
      }
      if (!cancelled && Date.now() - t0 > TIMEOUT_MS) {
        cancelled = true;
        log.push({ t: Date.now() - t0, harness: 'timeout → cancel_task' });
        await panel.evaluate(() => window.__port.postMessage({ type: 'cancel_task' }));
      }
      if (cancelled && Date.now() - t0 > TIMEOUT_MS + 30_000) {
        final = { state: 'harness.timeout', details: '' };
        await snap('final');
        break;
      }
    }
  } catch (e) {
    final = { state: 'harness.error', details: e.message.split('\n')[0] };
    log.push({ t: Date.now() - t0, harness: `error: ${e.stack}` });
  } finally {
    await ctx.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
  // Upper bound (tracker's inputTokens may already include cached reads); the key endpoint is authoritative.
  // Signature of the "subgoal ended the whole task" bug, checkable without a judge. Validated on the
  // 2026-09-27 baseline: the answer text flags 5 of the 6 judge-confirmed premature stops and no real
  // success. Plan progress is NOT a signal — Browd often marks only subgoal 1 done on genuine successes.
  const planDone = lastPlan.filter(i => i.done).length;
  const answerSaysUnfinished = /subgoal complete|remains to be|remaining (task|work|step)|next step/i.test(final.details || '');
  const estCost = (usage.in * PRICE.in + usage.cacheRead * PRICE.cached + usage.out * PRICE.out) / 1e6;
  const result = {
    task_id: task.task_id,
    task: task.confirmed_task,
    website: task.website,
    level: task.level,
    mode: MODE,
    prompt: taskText(task),
    action_history: actions,
    final_result_response: final.details,
    terminal_state: final.state,
    hitl,
    tools,
    seconds: Math.round((Date.now() - t0) / 1000),
    tokens: usage,
    est_cost_usd: Number(estCost.toFixed(4)),
    screenshots: shot,
    plan_done: planDone,
    plan_total: lastPlan.length,
    premature_stop_suspect: answerSaysUnfinished,
  };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 1));
  fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(log, null, 1));
  return result;
}

const env = loadEnv();
let tasks = JSON.parse(fs.readFileSync(path.resolve(arg('cases', path.join(HERE, 'subset30.json'))), 'utf8'));
const only = arg('only', null);
if (only) tasks = tasks.filter(t => only.split(',').some(id => t.task_id.startsWith(id)));
const adhoc = arg('task', null);
if (adhoc) {
  const url = arg('url', null);
  if (!url) throw new Error('--task needs --url (the start page)');
  tasks = [{ task_id: `adhoc-${Date.now()}`, confirmed_task: adhoc, website: url, level: 'adhoc' }];
}
const limit = arg('limit', null);
if (limit) tasks = tasks.slice(0, Number(limit));
fs.mkdirSync(OUT, { recursive: true });
const startUsage = await keyUsage(env.key);
console.log(`out=${OUT} mode=${MODE} tasks=${tasks.length} model=${env.model} keyUsage=$${startUsage}`);
for (const task of tasks) {
  if (fs.existsSync(path.join(OUT, task.task_id, 'result.json'))) continue;
  const used = await keyUsage(env.key);
  if (used >= BUDGET) {
    console.log(`budget stop: key usage $${used} >= $${BUDGET}`);
    break;
  }
  if (BEFORE_EACH) await fetch(BEFORE_EACH);
  const r = await runTask(task, env);
  const after = await keyUsage(env.key);
  console.log(
    `${task.level.padEnd(6)} ${r.terminal_state.padEnd(15)} ${String(r.seconds).padStart(4)}s acts=${r.action_history.length} tools=${JSON.stringify(r.tools)} shots=${r.screenshots} est=$${r.est_cost_usd} key=$${(after - used).toFixed(4)} plan=${r.plan_done}/${r.plan_total}${r.premature_stop_suspect ? ' PREMATURE_STOP?' : ''} | ${task.confirmed_task.slice(0, 70)}`,
  );
}
