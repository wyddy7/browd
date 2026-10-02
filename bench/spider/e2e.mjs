// Spider e2e, tier A: the built extension in Chromium, local fixtures, no
// model. Talks to the content script the way the background does and
// measures what the spider does on the page.
//
//   pnpm build && (cd bench/spider && npm ci && node e2e.mjs [--headed])
//
// Writes bench-runs/spider-e2e/<stamp>/report.json and a video of the run.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Checks, ROOT, extensionPage, launch, pixelDiff, serveFixtures, sleep, spider, stamp, tabIdOf } from './lib.mjs';

const HEADED = process.argv.includes('--headed');
const OUT = path.join(ROOT, 'bench-runs', 'spider-e2e', stamp());
fs.mkdirSync(OUT, { recursive: true });

const LOOK = { size: 1, pace: 'normal', marks: 'target' };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const r1 = x => Math.round(x * 10) / 10;
const rectOf = (page, sel) =>
  page.evaluate(s => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, sel);
const centre = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

const checks = new Checks();
const { server, base } = await serveFixtures();
const { ctx, extId } = await launch({ headless: !HEADED, video: path.join(OUT, 'video') });

try {
  const ext = await extensionPage(ctx, extId);
  const page = await ctx.newPage();
  await page.goto(`${base}/article.html`);
  await page.bringToFront();
  const tabId = await tabIdOf(ext, page.url());
  const send = spider(ext, tabId);

  // C1 — a page the agent does not drive gets nothing.
  await sleep(1200);
  const hostAtRest = await page.evaluate(() => !!document.querySelector('browd-spider'));
  const st0 = await send({ op: 'state' });
  checks.record(
    'C1',
    'no overlay on a page the agent does not drive; content script answers in the top frame',
    !hostAtRest && st0?.ok === true && st0.visible === false,
    { hostElement: hostAtRest, contentScript: st0?.ok === true },
  );

  // C2 — spawn: descends on a thread and lands where asked.
  await send({ op: 'spawn', look: LOOK, at: { x: 900, y: 300 } });
  await sleep(1800);
  let st = await send({ op: 'state' });
  const spawnEv = st.events.find(e => e.op === 'spawn');
  const landed = st.events.find(e => e.op === 'landed');
  checks.record(
    'C2',
    'spawn: descends on a thread and lands at the requested point',
    !!landed && dist(landed.body, { x: 900, y: 300 }) < 8 && landed.t - spawnEv.t < 1500,
    { landedAfterMs: landed ? landed.t - spawnEv.t : null, landedAt: landed?.body },
  );

  // C3 — isolation: closed shadow root on <html>, no pointer events.
  const iso = await page.evaluate(() => {
    const h = document.querySelector('browd-spider');
    return {
      shadowHidden: h.shadowRoot === null,
      pointerEvents: getComputedStyle(h).pointerEvents,
      onHtml: h.parentElement === document.documentElement,
      zIndex: getComputedStyle(h).zIndex,
    };
  });
  checks.record(
    'C3',
    'host: closed shadow root on <html>, pointer-events none, top z-index',
    iso.shadowHidden && iso.pointerEvents === 'none' && iso.onHtml && iso.zIndex === '2147483647',
    iso,
  );

  // C4/C5 — idle wandering: alive, zero DOM mutations, no long tasks, 60 fps.
  await page.evaluate(() => {
    const hash = s => {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return h;
    };
    window.__hash = hash;
    window.__h0 = hash(document.documentElement.outerHTML);
    window.__mut = 0;
    new MutationObserver(l => (window.__mut += l.length)).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    window.__long = [];
    new PerformanceObserver(l => window.__long.push(...l.getEntries().map(e => Math.round(e.duration)))).observe({
      type: 'longtask',
    });
  });
  const bodyA = st.pose.body;
  const trail = [];
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    trail.push((await send({ op: 'state' })).pose.body);
  }
  st = await send({ op: 'state' });
  const quiet = await page.evaluate(() => ({
    mutations: window.__mut,
    outerHTMLUnchanged: window.__hash(document.documentElement.outerHTML) === window.__h0,
    longTasks: window.__long,
  }));
  const wandered = Math.max(...trail.map(p => dist(p, bodyA)));
  checks.record(
    'C4',
    'idle wandering for 6 s: it moves, the page DOM does not change',
    wandered > 20 && quiet.mutations === 0 && quiet.outerHTMLUnchanged,
    { wanderedPx: r1(wandered), mutations: quiet.mutations, outerHTMLUnchanged: quiet.outerHTMLUnchanged },
  );
  checks.record(
    'C5',
    'frame budget while wandering on a long page',
    st.frameMs > 0 && st.frameMs < 20 && quiet.longTasks.length === 0,
    { frameMs: r1(st.frameMs), longTasks: quiet.longTasks },
  );

  // C6/C7 — approach the Subscribe button: under the cap, hands on the point, no jumps.
  const btn = await rectOf(page, '#subscribe');
  const pt = centre(btn);
  const startBody = (await send({ op: 'state' })).pose.body;
  const samples = [];
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const s = await send({ op: 'state' });
      samples.push({ t: Date.now(), body: s.pose.body });
    }
  })();
  const t0 = Date.now();
  const ack = await send({ op: 'approach', point: pt, rect: btn, capMs: 900 });
  const flightMs = Date.now() - t0;
  await sleep(300);
  polling = false;
  await poller;
  st = await send({ op: 'state' });
  const handErr = Math.max(...st.pose.hands.map(h => dist(h, pt)));
  checks.record(
    'C6',
    'approach: arrives at the button under the cap, both hands on the click point',
    ack.arrived === true && flightMs < 900 && handErr < 8,
    { startDistPx: r1(dist(startBody, pt)), flightMs, arrived: ack.arrived, handErrPx: r1(handErr) },
  );
  // Polling is faster than frames, so compare distinct positions: each one is a frame.
  const frames = samples.filter((s, i) => i === 0 || dist(s.body, samples[i - 1].body) > 0);
  const steps = frames.slice(1).map((s, i) => dist(s.body, frames[i].body));
  const sorted = [...steps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const maxStep = Math.max(0, ...steps);
  // 2400 px/s at 60 fps is 40 px per frame; a dropped frame may double it once.
  checks.record(
    'C7',
    'no jumps on the way: every frame-to-frame body step stays under the speed cap',
    frames.length > 10 && maxStep <= 2 * 40,
    { frames: frames.length, maxStepPx: r1(maxStep), medianStepPx: r1(median) },
  );

  // C8 — strike, then a real click at the same point reaches the button.
  const sAck = await send({ op: 'strike', point: pt, rect: btn });
  const topEl = await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.id, pt);
  await page.mouse.click(pt.x, pt.y);
  const lastClick = await page.evaluate(() => window.__clicks.at(-1));
  const counter = await page.evaluate(() => document.getElementById('count').textContent);
  st = await send({ op: 'state' });
  const strikeEv = st.events.filter(e => e.op === 'strike').at(-1);
  checks.record(
    'C8',
    'strike lands on the point, then a real click passes through the overlay',
    sAck.ok && topEl === 'subscribe' && lastClick?.id === 'subscribe' && counter.startsWith('1 ') && strikeEv &&
      dist(strikeEv.point, pt) < 1 && strikeEv.t <= lastClick.t,
    {
      elementFromPoint: topEl,
      clickTarget: lastClick?.id,
      counter,
      strikeBeforeClickMs: strikeEv ? lastClick.t - strikeEv.t : null,
    },
  );

  // C9 — typing: walk to the field, tap, drum while the keys go in.
  const field = await rectOf(page, '#email');
  const fpt = centre(field);
  await send({ op: 'approach', point: fpt, rect: field, capMs: 900 });
  await send({ op: 'strike', point: fpt, rect: field });
  await page.mouse.click(fpt.x, fpt.y);
  await send({ op: 'typing', on: true });
  const handsDuring = [];
  const typingDone = page.keyboard.type('spider@example.com', { delay: 45 });
  for (let i = 0; i < 6; i++) {
    await sleep(70);
    handsDuring.push((await send({ op: 'state' })).pose.hands[0]);
  }
  await typingDone;
  await send({ op: 'typing', on: false });
  const value = await page.evaluate(() => document.getElementById('email').value);
  const drum = Math.max(...handsDuring.map(h => dist(h, handsDuring[0])));
  checks.record(
    'C9',
    'typing: text reaches the field while the hands drum on it',
    value === 'spider@example.com' && drum > 1,
    { value, handTravelPx: r1(drum) },
  );

  // C10 — scrolling: feet are planted in the page, ride it, then re-step.
  await page.evaluate(() => document.activeElement?.blur());
  await send({ op: 'approach', point: { x: 640, y: 420 }, capMs: 900 });
  await sleep(500);
  await page.evaluate(() => window.scrollBy(0, 420));
  await sleep(60);
  const justAfter = await send({ op: 'state' });
  await sleep(1200);
  const settled = await send({ op: 'state' });
  const reach = p => Math.max(...p.feet.map(f => dist(f, p.body)));
  checks.record(
    'C10',
    'scroll: feet ride the page (stretched right after), then step back under the body',
    reach(justAfter.pose) > 90 && reach(settled.pose) < 75,
    { maxFootDistAfter60msPx: r1(reach(justAfter.pose)), maxFootDistAfter1300msPx: r1(reach(settled.pose)) },
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(800);

  // C11 — background tab: no animation frames, the approach must not wait.
  // Headless keeps every tab visible, so this runs only with --headed.
  await ext.bringToFront();
  await sleep(400);
  const visibility = await page.evaluate(() => document.visibilityState);
  if (visibility === 'hidden') {
    const t1 = Date.now();
    const hAck = await send({ op: 'approach', point: { x: 300, y: 300 }, capMs: 900 });
    const hiddenMs = Date.now() - t1;
    checks.record(
      'C11',
      'background tab: approach resolves at once (no waiting on frames)',
      hiddenMs < 300 && hAck.arrived === false,
      { visibility, ms: hiddenMs, reason: hAck.reason },
    );
  } else {
    checks.skip('C11', 'background tab: approach resolves at once', 'headless keeps background tabs visible; run with --headed');
  }
  await page.bringToFront();
  await sleep(800);

  // C12 — screenshots: hidden spider leaves no pixel; the check itself can see it.
  await send({ op: 'approach', point: { x: 700, y: 360 }, capMs: 900 });
  await sleep(1300); // let the target outline fade
  const shotVisible = await page.screenshot();
  await send({ op: 'hide' });
  const shotHidden = await page.screenshot();
  await send({ op: 'show' });
  await send({ op: 'leave' });
  await sleep(1800);
  const goneHost = await page.evaluate(() => !!document.querySelector('browd-spider'));
  const shotGone = await page.screenshot();
  const dVisible = await pixelDiff(ext, shotGone, shotVisible);
  const dHidden = await pixelDiff(ext, shotGone, shotHidden);
  checks.record(
    'C12',
    'hide before a screenshot: zero spider pixels (the same check sees it when visible)',
    dHidden.pixels === 0 && dVisible.pixels > 200,
    { pixelsWhenVisible: dVisible.pixels, pixelsWhenHidden: dHidden.pixels, visibleBox: dVisible.box },
  );

  // C13 — leave: climbs away and removes its element.
  st = await send({ op: 'state' });
  checks.record('C13', 'leave: climbs out of view and removes the host element', !goneHost && st.events.at(-1)?.op === 'gone', {
    hostElement: goneHost,
    lastEvent: st.events.at(-1)?.op,
  });

  // C14 — navigation: the next page has a fresh content script and no overlay of its own.
  await page.click('#next');
  await page.waitForURL(/second\.html/);
  await sleep(800);
  const tab2 = await tabIdOf(ext, page.url());
  const st2 = await spider(ext, tab2)({ op: 'state' });
  const host2 = await page.evaluate(() => !!document.querySelector('browd-spider'));
  const appr = await spider(ext, tab2)({ op: 'approach', point: { x: 100, y: 100 }, capMs: 300 });
  checks.record(
    'C14',
    'after navigation: fresh content script, nothing drawn until told, commands report not-spawned',
    st2?.ok && !host2 && appr.reason === 'not-spawned',
    { contentScript: st2?.ok, hostElement: host2, approachReason: appr.reason },
  );

  await page.close();
  await ext.close();
} finally {
  await ctx.close();
}

// C15 — prefers-reduced-motion: no flight, no thread; jumps straight to the target.
{
  const { ctx: rctx, extId: rid } = await launch({ headless: !HEADED, reducedMotion: 'reduce' });
  try {
    const ext = await extensionPage(rctx, rid);
    const page = await rctx.newPage();
    await page.goto(`${base}/article.html`);
    await page.bringToFront();
    const send = spider(ext, await tabIdOf(ext, page.url()));
    await send({ op: 'spawn', look: LOOK, at: { x: 600, y: 300 } });
    const t0 = Date.now();
    const a = await send({ op: 'approach', point: { x: 300, y: 500 }, capMs: 900 });
    const ms = Date.now() - t0;
    await sleep(1500);
    const st = await send({ op: 'state' });
    const descended = st.events.some(e => e.op === 'landed');
    checks.record(
      'C15',
      'reduced motion: no descent animation, approach jumps without waiting, no wandering',
      a.reason === 'reduced-motion' && ms < 200 && !descended && st.pose.speed === 0,
      { reason: a.reason, ms, descentAnimated: descended, speed: st.pose.speed },
    );
  } finally {
    await rctx.close();
  }
}

server.close();

// Video → mp4 + contact sheet for a quick look.
const vids = fs.existsSync(path.join(OUT, 'video')) ? fs.readdirSync(path.join(OUT, 'video')) : [];
const webm = vids
  .map(f => path.join(OUT, 'video', f))
  .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
if (webm) {
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', path.join(OUT, 'e2e.mp4')]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(OUT, 'e2e.mp4'), '-vf', 'fps=1,scale=480:-1,tile=5x4', '-frames:v', '1', path.join(OUT, 'e2e-sheet.png')]);
  } catch (e) {
    console.log(`ffmpeg skipped: ${e.message.split('\n')[0]}`);
  }
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ when: new Date().toISOString(), checks: checks.rows }, null, 2));
const ran = checks.rows.filter(r => r.pass !== null).length;
console.log(`\n${ran - checks.failed.length}/${ran} passed, ${checks.rows.length - ran} skipped → ${OUT}`);
process.exit(checks.failed.length ? 1 : 0);
