// Spider e2e, tier B: the real agent pipeline (side-panel port → executor →
// planner → ReAct agent → actions → Page → spider bridge → content script)
// against a scripted OpenAI-compatible model served from localhost. No
// network, no money. The task crosses a navigation, types into a field,
// clicks a button and takes one screenshot.
//
//   pnpm build && (cd bench/spider && npm ci && node pipeline.mjs)
//
// Writes bench-runs/spider-pipeline/<stamp>/{report.json,llm-requests.jsonl,agent-shot.jpg,...}
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Checks, ROOT, extensionPage, launch, pixelDiff, serveFixtures, sleep, spider, stamp, tabIdOf } from './lib.mjs';

const HEADED = process.argv.includes('--headed');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
// Look of the spider for this run: --marks off|target|feet --size 0.8..1.35 --pace calm|normal|fast
const LOOK = { size: Number(arg('size', '1')), pace: arg('pace', 'normal'), marks: arg('marks', 'target'), color: arg('color', 'violet'), tear: arg('tear', 'on') !== 'off' };
const OUT = path.join(ROOT, 'bench-runs', 'spider-pipeline', stamp());
fs.mkdirSync(OUT, { recursive: true });
const MODEL = 'mock-gpt-4o-spider'; // "gpt-4o" in the name → vision on → screenshot() tool present
const EMAIL = 'spider@example.com';
const TASK = `Go to the second page, join the arachnid society with the email ${EMAIL}, then take a screenshot to confirm.`;

// ---------- scripted model ----------

const reqLog = fs.createWriteStream(path.join(OUT, 'llm-requests.jsonl'));
const script = { stage: 'link', calls: [] };
// A real model takes a while: the spider reads (and tears words) meanwhile.
const THINK_MS = Number(arg('think', '1200'));
// Before the screenshot step the model waits here, so the harness can flip the chat toggle mid-task.
let releaseGate;
const gate = new Promise(r => (releaseGate = r));
let gateReached;
const atGate = new Promise(r => (gateReached = r));
let callSeq = 0;

const textOf = content =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(p => (typeof p === 'string' ? p : (p.text ?? ''))).join('\n')
      : '';

/** Interactive element lines as browd renders them: `[12]<button ...>Join</button>`. */
function elements(text) {
  const out = [];
  const re = /\[(\d+)\]<(\w+)([^>]*)>([^\n<]*)/g;
  let m;
  while ((m = re.exec(text))) out.push({ index: Number(m[1]), tag: m[2], attrs: m[3], text: m[4].trim() });
  return out;
}

function decide(body) {
  const tools = (body.tools || []).map(t => t.function?.name).filter(Boolean);
  const forced = body.tool_choice?.function?.name ?? null;
  const rf = body.response_format?.json_schema?.name ?? null;
  const msgs = body.messages || [];
  const lastUser = [...msgs].reverse().find(m => m.role === 'user');
  const state = textOf(lastUser?.content);

  if (forced === 'plan' || rf === 'plan' || (tools.length === 1 && tools[0] === 'plan')) {
    return {
      kind: 'plan',
      tool: 'plan',
      args: {
        reasoning: 'Open the second page, fill the email, join, then confirm with a screenshot.',
        plan: ['Join the arachnid society on the second page and confirm with a screenshot'],
        taskParameters: { urls: [], queries: [], names: [EMAIL] },
      },
    };
  }
  if (forced === 'replan' || rf === 'replan' || (tools.length === 1 && tools[0] === 'replan')) {
    return {
      kind: 'replan',
      tool: 'replan',
      args: { decision: 'finish', plan: null, outcome: 'answered', response: `Joined with ${EMAIL}.` },
    };
  }
  if (forced === 'task_complete' || (tools.includes('task_complete') && !tools.includes('click_element'))) {
    return { kind: 'final', tool: 'task_complete', args: { intent: 'finish', outcome: 'answered', response: `Joined with ${EMAIL}.` } };
  }
  if (tools.includes('click_element')) {
    const els = elements(state);
    const onSecond = /second\.html/.test(state.slice(state.lastIndexOf('http')));
    const find = pred => els.find(pred);
    if (script.stage === 'link') {
      const link = find(e => e.tag === 'a' && /second page/i.test(e.text));
      if (link) {
        script.stage = 'type';
        return { kind: 'act', tool: 'click_element', args: { intent: 'open the second page', index: link.index } };
      }
    }
    if (script.stage === 'type' || (script.stage === 'link' && onSecond)) {
      const input = find(e => e.tag === 'input' && /member-email|email/i.test(e.attrs));
      if (input) {
        script.stage = 'join';
        return { kind: 'act', tool: 'input_text', args: { intent: 'enter the email', index: input.index, text: EMAIL } };
      }
    }
    if (script.stage === 'join') {
      const btn = find(e => e.tag === 'button' && /join/i.test(e.text));
      if (btn) {
        script.stage = 'shot';
        return { kind: 'act', tool: 'click_element', args: { intent: 'join', index: btn.index } };
      }
    }
    if (script.stage === 'shot' && tools.includes('screenshot')) {
      script.stage = 'done';
      return { kind: 'act', tool: 'screenshot', args: { intent: 'confirm the result' } };
    }
    if (script.stage === 'shot' || script.stage === 'done') {
      script.stage = 'finished';
      return { kind: 'act', tool: 'task_complete', args: { intent: 'finish', outcome: 'answered', response: `Joined with ${EMAIL}.` } };
    }
    return { kind: 'stuck', text: `No matching element at stage ${script.stage}.` };
  }
  return { kind: 'text', text: 'ok' };
}

function completion(body, d) {
  const id = `chatcmpl-${++callSeq}`;
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
  const toolCall = d.tool
    ? [{ index: 0, id: `call_${callSeq}`, type: 'function', function: { name: d.tool, arguments: JSON.stringify(d.args) } }]
    : null;
  const useContent = !toolCall || (body.response_format && !body.tools);
  const content = useContent ? (d.tool ? JSON.stringify(d.args) : d.text) : null;
  const finish = toolCall && !useContent ? 'tool_calls' : 'stop';
  if (!body.stream) {
    return {
      json: {
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: MODEL,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content, ...(toolCall && !useContent ? { tool_calls: toolCall.map(({ index, ...t }) => t) } : {}) },
            finish_reason: finish,
          },
        ],
        usage,
      },
    };
  }
  const chunk = (delta, finish_reason = null, extra = {}) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`;
  const parts = [chunk({ role: 'assistant', content: content ?? '' })];
  if (toolCall && !useContent) parts.push(chunk({ tool_calls: toolCall }));
  parts.push(chunk({}, finish), chunk({}, null, { choices: [], usage }), 'data: [DONE]\n\n');
  return { sse: parts.join('') };
}

function mock(req, res) {
  if (!req.url.startsWith('/v1/')) return false;
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: MODEL }] }));
    return true;
  }
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const d = decide(body);
    script.calls.push({ t: Date.now(), kind: d.kind, tool: d.tool ?? null, stage: script.stage });
    reqLog.write(
      JSON.stringify({
        t: Date.now(),
        decided: d,
        stream: !!body.stream,
        tool_choice: body.tool_choice ?? null,
        response_format: body.response_format ? Object.keys(body.response_format) : null,
        tools: (body.tools || []).map(t => t.function?.name),
        messages: (body.messages || []).map(m => ({
          role: m.role,
          text: textOf(m.content).slice(0, 4000),
          images: Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url').length : 0,
          tool_calls: m.tool_calls?.map(c => c.function?.name),
        })),
      }) + '\n',
    );
    // Keep the screenshot the agent got: the next request carries it.
    for (const m of body.messages || []) {
      if (!Array.isArray(m.content)) continue;
      for (const p of m.content) {
        const url = p?.image_url?.url;
        if (url?.startsWith('data:image/')) {
          fs.writeFileSync(path.join(OUT, 'agent-shot.jpg'), Buffer.from(url.split(',')[1], 'base64'));
        }
      }
    }
    const out = completion(body, d);
    const reply = () => {
      if (out.json) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out.json));
      else res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }).end(out.sse);
    };
    const held = d.tool === 'screenshot' ? (gateReached(), gate) : Promise.resolve();
    held.then(() => setTimeout(reply, THINK_MS));
  });
  return true;
}

// ---------- run ----------

const checks = new Checks();
const { server, base } = await serveFixtures(undefined, mock);
const { ctx, extId, swLines } = await launch({ headless: !HEADED, video: path.join(OUT, 'video'), swLog: true });
const evLog = [];
const spiderByUrl = new Map();
const shadowChecks = [];
let terminal = null;

try {
  const setup = await extensionPage(ctx, extId, 'side-panel/index.html');
  await setup.evaluate(
    cfg => chrome.storage.local.set(cfg),
    {
      'llm-api-keys': {
        providers: {
          mock: { apiKey: 'mock', name: 'Mock', type: 'custom_openai', baseUrl: `${base}/v1`, modelNames: [MODEL], createdAt: Date.now() },
        },
      },
      'agent-models': {
        agents: { planner: { provider: 'mock', modelName: MODEL }, navigator: { provider: 'mock', modelName: MODEL } },
      },
      'firewall-settings': { allowList: [], denyList: [], enabled: false },
      'spider-settings': { enabled: true, ...LOOK },
      'general-settings': {
        maxSteps: 20,
        maxActionsPerStep: 5,
        maxFailures: 3,
        useVision: false,
        useVisionForPlanner: false,
        planningInterval: 3,
        displayHighlights: false,
        minWaitPageLoad: 250,
        replayHistoricalTasks: false,
        launchShortcut: 'Ctrl+E',
        agentMode: 'unified',
        visionMode: 'on',
        permissionMode: 'full',
        appearanceTheme: 'light',
        interfaceLanguage: 'system',
      },
    },
  );
  await setup.close();

  const page = await ctx.newPage();
  await page.goto(`${base}/article.html`);
  await page.evaluate(() => {
    window.__inputs = [];
    document.addEventListener('input', e => window.__inputs.push({ t: Date.now(), id: e.target.id }), true);
  });

  const panel = await ctx.newPage();
  await panel.addInitScript(() => {
    window.__ev = [];
    const orig = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = (...a) => {
      const p = orig(...a);
      if (a[0] && a[0].name === 'side-panel-connection') {
        window.__port = p;
        p.onMessage.addListener(m => window.__ev.push(m));
      }
      return p;
    };
  });
  await panel.goto(`chrome-extension://${extId}/side-panel/index.html`);
  await panel.waitForTimeout(2000);
  await panel.evaluate(() => {
    if (!window.__port) chrome.runtime.connect({ name: 'side-panel-connection' });
  });
  await page.bringToFront();
  const tabId = await tabIdOf(panel, page.url());
  const send = spider(panel, tabId);
  // The second page records its own input events too.
  await ctx.addInitScript(() => {
    window.__inputs = [];
    document.addEventListener('input', e => window.__inputs.push({ t: Date.now(), id: e.target.id }), true);
  });
  const t0 = Date.now();
  await panel.evaluate(
    ({ task, tabId }) => window.__port.postMessage({ type: 'new_task', task, taskId: crypto.randomUUID(), tabId, priorMessages: [] }),
    { task: TASK, tabId },
  );

  let toggle = null;
  atGate.then(async () => {
    // P11: hide the spider from the chat input mid-task, then show it again.
    const btn = panel.locator('[data-testid="spider-toggle"]');
    const hostThere = () => page.evaluate(() => !!document.querySelector('browd-spider')).catch(() => null);
    const before = await hostThere();
    const tOff = Date.now();
    await btn.click();
    let goneMs = null;
    while (Date.now() - tOff < 4000) {
      if ((await hostThere()) === false) {
        goneMs = Date.now() - tOff;
        break;
      }
      await sleep(50);
    }
    const tOn = Date.now();
    await btn.click();
    let backMs = null;
    while (Date.now() - tOn < 4000) {
      if (await hostThere()) {
        backMs = Date.now() - tOn;
        break;
      }
      await sleep(50);
    }
    const pressed = await btn.getAttribute('aria-pressed');
    toggle = { before, goneMs, backMs, pressedAfter: pressed };
    await sleep(800);
    releaseGate();
  });
  while (Date.now() - t0 < 120_000) {
    await sleep(150);
    const evs = await panel.evaluate(() => window.__ev.splice(0));
    for (const e of evs) {
      evLog.push({ t: Date.now() - t0, ...e });
      const state = e.state || e.data?.state;
      if (['task.ok', 'task.fail', 'task.cancel'].includes(state)) terminal = state;
    }
    // Snapshot the spider of whatever page is loaded now (its event log dies with the page).
    try {
      const st = await send({ op: 'state' });
      if (st?.events) spiderByUrl.set(page.url(), st);
      const sh = await page.evaluate(() => {
        const h = document.querySelector('browd-spider');
        return h ? { present: true, shadowHidden: h.shadowRoot === null } : { present: false };
      });
      if (sh.present) shadowChecks.push(sh.shadowHidden);
    } catch {
      /* page navigating */
    }
    if (terminal) break;
  }
  const endT = Date.now();
  // The done gesture (~0.7 s) plays before the climb (~1.5 s).
  await sleep(3500);
  const hostAfter = await page.evaluate(() => !!document.querySelector('browd-spider')).catch(() => null);
  const final = await send({ op: 'state' }).catch(() => null);
  if (final?.events) spiderByUrl.set(page.url(), final);
  const cleanShot = await page.screenshot({ type: 'jpeg', quality: 92 });
  fs.writeFileSync(path.join(OUT, 'clean-after.jpg'), cleanShot);

  const second = await page.evaluate(() => ({
    url: location.href,
    done: document.getElementById('done')?.textContent,
    clicks: window.__clicks,
    inputs: window.__inputs,
    value: document.getElementById('member-email')?.value,
  }));
  const firstEvents = [...spiderByUrl.entries()].find(([u]) => u.includes('article'))?.[1]?.events ?? [];
  const secondEvents = spiderByUrl.get(second.url)?.events ?? [];

  // P1 — the real pipeline completed the task.
  checks.record(
    'P1',
    'agent pipeline finishes the task on the scripted model (navigate → type → click → screenshot)',
    terminal === 'task.ok' && second.done === `Welcome, ${EMAIL}`,
    { terminal, page: second.url.replace(base, ''), done: second.done, modelCalls: script.calls.map(c => c.tool ?? c.kind) },
  );

  // P2 — spawned when the agent attached, and walked to the link before clicking it.
  // The first page's own log dies with the navigation, so read the bridge's line.
  const strikeLines = swLines.filter(l => l.text.includes('[Spider] strike'));
  const linkLine = strikeLines[0]?.text ?? '';
  checks.record(
    'P2',
    'first page: spider spawned on attach and tapped the link before the navigation',
    firstEvents.some(e => e.op === 'spawn') && /arrived=true/.test(linkLine) && /struck=true/.test(linkLine),
    { bridge: linkLine.replace('[Spider] ', ''), pageLogBeforeUnload: firstEvents.map(e => e.op).join(' ') },
  );

  // P3 — the navigation is a teleport: the old page reported where the spider was as it unloaded,
  // and the new page's spider appears at that spot (no second descent on a thread).
  const unloadLine = swLines.find(l => l.text.includes('[Spider] unload'))?.text ?? '';
  const unloadAt = /at=(-?\d+),(-?\d+)/.exec(unloadLine);
  const spawn2 = secondEvents.find(e => e.op === 'spawn' || e.op === 'spawn-teleport');
  const firstAct2 = secondEvents.find(e => e.op === 'approach');
  const off2 =
    unloadAt && spawn2 ? Math.hypot(spawn2.body.x - Number(unloadAt[1]), spawn2.body.y - Number(unloadAt[2])) : null;
  checks.record(
    'P3',
    'navigation = teleport: unload reports the spot, the next page spawns there as a teleport before acting, no descent',
    spawn2?.op === 'spawn-teleport' && off2 !== null && off2 <= 2 && !!firstAct2 && spawn2.t <= firstAct2.t &&
      !secondEvents.some(e => e.op === 'landed'),
    {
      unload: unloadLine.replace('[Spider] ', ''),
      secondPageSpawn: spawn2 && `${spawn2.op} at ${Math.round(spawn2.body.x)},${Math.round(spawn2.body.y)}`,
      offsetPx: off2 && Math.round(off2 * 10) / 10,
      spawnBeforeActionMs: spawn2 && firstAct2 ? firstAct2.t - spawn2.t : null,
    },
  );

  // P4 — typing: tapped the field centre, keys arrived inside typing-on/off.
  const fieldTap = secondEvents.find(e => e.op === 'strike');
  const tOn = secondEvents.find(e => e.op === 'typing-on');
  const tOff = secondEvents.find(e => e.op === 'typing-off');
  const inputs = (second.inputs || []).filter(i => i.id === 'member-email');
  checks.record(
    'P4',
    'input_text: strike on the field, every keystroke between typing-on and typing-off',
    second.value === EMAIL && fieldTap && tOn && tOff && inputs.length > 0 &&
      inputs.every(i => i.t >= tOn.t - 5 && i.t <= tOff.t + 5),
    { keystrokes: inputs.length, typingWindowMs: tOn && tOff ? tOff.t - tOn.t : null },
  );

  // P5 — the Join click: arrived, struck at the exact click point, then the click.
  const joinClick = (second.clicks || []).find(c => c.id === 'join-button');
  const strikes = secondEvents.filter(e => e.op === 'strike');
  const joinStrike = joinClick && strikes.filter(s => s.t <= joinClick.t + 5).at(-1);
  const arrive = joinStrike && secondEvents.filter(e => e.op === 'arrive' && e.t <= joinStrike.t).at(-1);
  const off = joinStrike && joinClick ? Math.hypot(joinStrike.point.x - joinClick.x, joinStrike.point.y - joinClick.y) : null;
  checks.record(
    'P5',
    'click_element: spider arrived and struck the click point before the real click',
    !!joinClick && !!joinStrike && arrive?.arrived === true && off < 2 && joinClick.t - joinStrike.t < 400,
    { strikeToClickMs: joinClick && joinStrike ? joinClick.t - joinStrike.t : null, pointOffsetPx: off, arrived: arrive?.arrived },
  );

  // P6 — screenshot path: hide → capture → show; the agent's image has no spider.
  const hide = secondEvents.filter(e => e.op === 'hide').at(-1);
  const show = hide && secondEvents.find(e => e.op === 'show' && e.t >= hide.t);
  let shotDiff = null;
  let control = null;
  if (fs.existsSync(path.join(OUT, 'agent-shot.jpg')) && hide?.body) {
    const agentShot = fs.readFileSync(path.join(OUT, 'agent-shot.jpg'));
    shotDiff = await pixelDiff(panel, agentShot, cleanShot, 60);
    // Control: the same comparison must see the spider when it is drawn at that spot.
    await send({ op: 'spawn', look: LOOK, at: hide.body });
    await sleep(1600);
    const withSpider = await page.screenshot({ type: 'jpeg', quality: 92 });
    control = await pixelDiff(panel, withSpider, cleanShot, 60);
    await send({ op: 'leave' });
  }
  checks.record(
    'P6',
    "screenshot(): spider hidden for the capture — the agent's image matches the page after it left",
    !!hide && !!show && shotDiff && shotDiff.pixels < 60 && control?.pixels > 300,
    {
      hideToShowMs: hide && show ? show.t - hide.t : null,
      bodyAtCapture: hide?.body,
      differingPixels: shotDiff?.pixels,
      controlPixelsWithSpiderDrawn: control?.pixels,
    },
  );

  // P7 — page isolation held while Puppeteer's attachShadow→open override was active.
  checks.record(
    'P7',
    "shadow root stayed closed with the agent's attachShadow override in the page",
    shadowChecks.length > 0 && shadowChecks.every(Boolean),
    { samples: shadowChecks.length },
  );

  // P8 — task end: climbs away and removes itself.
  checks.record('P8', 'task end: the spider leaves and its element is removed', hostAfter === false && final?.events?.at(-1)?.op === 'gone', {
    hostElement: hostAfter,
    lastEvent: final?.events?.at(-1)?.op,
    afterTaskMs: Date.now() - endT,
  });

  // P10 — the spider followed the agent's state: moods in order, ending with the done gesture before the climb.
  const moodOps = [...firstEvents, ...(final?.events ?? secondEvents)].filter(e => e.op.startsWith('mood:')).map(e => e.op.slice(5));
  const endEvents = final?.events ?? secondEvents;
  const doneEv = endEvents.find(e => e.op === 'mood:done');
  const leaveEv = endEvents.find(e => e.op === 'leave' && (!doneEv || e.t >= doneEv.t));
  const tears = [...firstEvents, ...endEvents].filter(e => e.op === 'tear').length;
  checks.record(
    'P10',
    'moods follow the agent (thinking → acting/waiting → done), the done gesture plays before it climbs away',
    moodOps.includes('thinking') && (moodOps.includes('acting') || moodOps.includes('waiting')) && !!doneEv && !!leaveEv &&
      leaveEv.t - doneEv.t >= 600,
    { moods: [...new Set(moodOps)].join(' → '), doneToLeaveMs: doneEv && leaveEv ? leaveEv.t - doneEv.t : null, wordsTorn: tears },
  );

  // P11 — the chat toggle hides and brings back the spider while the task runs.
  checks.record(
    'P11',
    'chat toggle mid-task: the spider leaves, then comes back',
    !!toggle && toggle.before === true && toggle.goneMs !== null && toggle.backMs !== null && toggle.pressedAfter === 'true',
    toggle ?? { error: 'gate never reached' },
  );

  // Cost of the decoration per action, as the bridge measured it (approach + strike).
  const pairs = strikeLines.map(l => Number(/ms=(\d+)/.exec(l.text)?.[1])).filter(Number.isFinite);
  checks.record('P9', 'added latency per action (approach + strike, bridge-measured)', pairs.length === 3, {
    perActionMs: pairs,
    meanMs: pairs.length ? Math.round(pairs.reduce((x, y) => x + y, 0) / pairs.length) : null,
    lines: strikeLines.map(l => l.text.replace('[Spider] ', '')),
  });

  fs.writeFileSync(path.join(OUT, 'events.json'), JSON.stringify({ panel: evLog, spider: Object.fromEntries(spiderByUrl) }, null, 2));
} finally {
  await ctx.close();
  server.close();
}

// The target page's video is the preview: real agent, real clicks.
const vdir = path.join(OUT, 'video');
const webm = fs.existsSync(vdir)
  ? fs
      .readdirSync(vdir)
      .map(f => path.join(vdir, f))
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]
  : null;
if (webm) {
  try {
    const mp4 = path.join(OUT, `agent-${LOOK.marks}.mp4`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', mp4]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-vf', 'fps=1.5,scale=640:-1,tile=4x4', '-frames:v', '1', path.join(OUT, 'sheet.png')]);
  } catch (e) {
    console.log(`ffmpeg skipped: ${e.message.split('\n')[0]}`);
  }
}

fs.writeFileSync(
  path.join(OUT, 'report.json'),
  JSON.stringify({ when: new Date().toISOString(), task: TASK, look: LOOK, checks: checks.rows }, null, 2),
);
const ran = checks.rows.filter(r => r.pass !== null).length;
console.log(`\n${ran - checks.failed.length}/${ran} passed → ${OUT}`);
process.exit(checks.failed.length ? 1 : 0);
