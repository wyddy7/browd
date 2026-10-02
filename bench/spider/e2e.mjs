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

const LOOK = { size: 1, pace: 'normal', marks: 'target', color: 'violet', tear: true };
// Longest leg at size 1 (femur 44 + tibia 54).
const MAX_LEG = 98;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const r1 = x => Math.round(x * 10) / 10;
const rectOf = (page, sel) =>
  page.evaluate(s => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, sel);
const centre = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

const checks = new Checks();
const allPoses = [];
const { server, base } = await serveFixtures();
const { ctx, extId } = await launch({ headless: !HEADED, video: path.join(OUT, 'video') });

/** Poll the pose as fast as the round trip allows while `work` runs (or for `ms`). */
async function sample(send, work, ms = 0) {
  const out = [];
  let on = true;
  const loop = (async () => {
    while (on) {
      const s = await send({ op: 'state' });
      out.push({ t: Date.now(), pose: s.pose, events: s.events, frame: s.frame });
    }
  })();
  const result = typeof work === 'function' ? await work() : await sleep(ms);
  if (ms && typeof work === 'function') await sleep(ms);
  on = false;
  await loop;
  allPoses.push(...out.map(o => o.pose));
  return { out, result };
}
const legLengths = pose => pose.hips.map((h, i) => dist(h, pose.feet[i]));

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

  // C2 — first entrance: descends on a thread and lands where asked.
  await send({ op: 'spawn', look: LOOK, at: { x: 900, y: 300, heading: 0 }, arrive: 'descend' });
  await sleep(1800);
  let st = await send({ op: 'state' });
  const spawnEv = st.events.find(e => e.op === 'spawn');
  const landed = st.events.find(e => e.op === 'landed');
  checks.record(
    'C2',
    'first entrance: descends on a thread and lands at the requested point',
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

  // C4/C5 — between actions it reads: walks into text blocks, hands on the lines; the page DOM never changes.
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
    // Is a point on a text line? (caret position under it, then that text node's line boxes)
    window.__onText = (x, y) => {
      const r = document.caretRangeFromPoint(x, y);
      if (!r || r.startContainer.nodeType !== 3) return false;
      const range = document.createRange();
      range.selectNodeContents(r.startContainer);
      return Array.from(range.getClientRects()).some(b => x >= b.left - 6 && x <= b.right + 6 && y >= b.top - 6 && y <= b.bottom + 6);
    };
  });
  const reading = await sample(send, null, 9000);
  st = await send({ op: 'state' });
  const quiet = await page.evaluate(() => ({
    mutations: window.__mut,
    outerHTMLUnchanged: window.__hash(document.documentElement.outerHTML) === window.__h0,
    longTasks: window.__long,
  }));
  const readEvents = st.events.filter(e => e.op === 'read');
  const readPoints = new Set(readEvents.map(e => `${Math.round(e.point.x / 20)}:${Math.round(e.point.y / 20)}`));
  // Stop-and-go, the way a spider moves: frozen part of the time, short fast bursts in between.
  const idleSamples = reading.out.filter(o => o.pose.mode.startsWith('idle'));
  const stillShare = idleSamples.filter(o => o.pose.speed < 10).length / Math.max(1, idleSamples.length);
  const burstPeak = Math.max(0, ...idleSamples.map(o => o.pose.speed));
  checks.record(
    'C4',
    '9 s between actions: reads ≥2 blocks in bursts and freezes; page DOM unchanged',
    readPoints.size >= 2 && stillShare >= 0.3 && stillShare <= 0.9 && burstPeak > 150 && quiet.mutations === 0 && quiet.outerHTMLUnchanged,
    {
      blocksRead: readPoints.size,
      stillShare: Math.round(stillShare * 100) / 100,
      burstPeakPxS: Math.round(burstPeak),
      mutations: quiet.mutations,
      outerHTMLUnchanged: quiet.outerHTMLUnchanged,
    },
  );

  // C4b — focus words: it tears the words the agent looks for out of the page (overlay only).
  await send({ op: 'focus', words: ['spider', 'press', 'isbn'] });
  await send({ op: 'mood', mood: 'thinking' });
  let torn = null;
  const tearSamples = [];
  for (let i = 0; i < 60 && !torn; i++) {
    await sleep(200);
    const st = await send({ op: 'state' });
    tearSamples.push(st);
    if (st.stickers?.length) torn = st;
  }
  const tearEvents = (torn ?? tearSamples.at(-1)).events.filter(e => e.op === 'tear');
  const afterTear = await page.evaluate(() => ({
    mutations: window.__mut,
    outerHTMLUnchanged: window.__hash(document.documentElement.outerHTML) === window.__h0,
  }));
  checks.record(
    'C4b',
    'focus words: tears one out (hole + sticker on the canvas), the page DOM stays untouched',
    !!torn && /spider|press|isbn/i.test(torn.stickers[0].text) && afterTear.mutations === 0 && afterTear.outerHTMLUnchanged,
    { firstTornAfterMs: torn ? tearSamples.length * 200 : null, word: torn?.stickers[0].text, tears: tearEvents.length, mutations: afterTear.mutations },
  );

  // C4c — a new action takes every word back at once: send it while a word is out.
  let before4c = 0;
  for (let i = 0; i < 80 && !before4c; i++) {
    const live = (await send({ op: 'state' })).stickers.filter(x => x.phase !== 'back');
    before4c = live.length;
    if (!before4c) await sleep(150);
  }
  // Read the stickers right after the approach is sent, not after it lands.
  const going = send({ op: 'approach', point: { x: 640, y: 400 }, capMs: 900 });
  const back4c = (await send({ op: 'state' })).stickers.map(x => x.phase);
  await going;
  await sleep(900);
  const left4c = (await send({ op: 'state' })).stickers.length;
  checks.record(
    'C4c',
    'an action sends every torn word home right away; gone within ~1 s',
    before4c >= 1 && back4c.length >= 1 && back4c.every(ph => ph === 'back') && left4c === 0,
    { liveBefore: before4c, phasesRightAfter: back4c, liveAfter900ms: left4c },
  );
  await send({ op: 'focus', words: [] });
  checks.record(
    'C5',
    'frame budget while reading a long page (block sampling and tearing included)',
    st.frameMs > 0 && st.frameMs < 20 && quiet.longTasks.length === 0,
    { frameMs: r1(st.frameMs), longTasks: quiet.longTasks },
  );

  // C20 — nothing jolts while it reads: frame-to-frame change of the body's velocity stays small.
  {
    // One sample per drawn frame, timed by the frame clock of the page, not by when the poll came back.
    const fr = reading.out.filter((o, i) => i === 0 || o.frame.n !== reading.out[i - 1].frame.n);
    const vel = fr.slice(1).map((o, i) => {
      const dt = (o.frame.t - fr[i].frame.t) / 1000;
      const gap = o.frame.n - fr[i].frame.n;
      return { x: (o.pose.body.x - fr[i].pose.body.x) / dt, y: (o.pose.body.y - fr[i].pose.body.y) / dt, gap };
    });
    // Only directly consecutive frames count (a frame the poll skipped is not a jolt).
    const dv = vel
      .slice(1)
      .map((v, i) => ({ v, prev: vel[i] }))
      .filter(({ v, prev }) => v.gap === 1 && prev.gap === 1)
      .map(({ v, prev }) => Math.hypot(v.x - prev.x, v.y - prev.y));
    const sorted = [...dv].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const peak = Math.max(0, ...vel.filter(v => v.gap === 1).map(v => Math.hypot(v.x, v.y)));
    checks.record(
      'C20',
      'smooth reading: velocity changes ≤ 160 px/s per frame (p95), peak speed under 500 px/s',
      dv.length > 50 && p95 <= 160 && peak < 500,
      { frames: dv.length, p95DeltaV: Math.round(p95), peakSpeed: Math.round(peak) },
    );
  }

  // C22 — while the agent reads the DOM it holds still: eases out of a move, starts none until done.
  {
    let moving = null;
    for (let i = 0; i < 80 && !moving; i++) {
      const st = await send({ op: 'state' });
      if (st.pose.speed > 120 && st.pose.mode.startsWith('idle')) moving = st;
      else await sleep(25);
    }
    await send({ op: 'scan', on: true });
    const held = await sample(send, null, 1200);
    await send({ op: 'scan', on: false });
    const later = held.out.filter(o => o.t - held.out[0].t > 300);
    const maxLater = Math.max(0, ...later.map(o => o.pose.speed));
    const drift = later.length ? dist(later[0].pose.body, later.at(-1).pose.body) : null;
    checks.record(
      'C22',
      'agent reading the DOM: the spider eases to a stop and starts no new move until it is done',
      !!moving && maxLater < 25 && drift !== null && drift < 3,
      { speedWhenAsked: moving && Math.round(moving.pose.speed), maxSpeedAfter300ms: Math.round(maxLater), driftPx: drift && r1(drift) },
    );
  }

  // C6/C7 — a long approach: crouch and pull back, leap with legs gathered, land with one small overshoot.
  await send({ op: 'approach', point: { x: 1050, y: 560 }, capMs: 900 });
  await sleep(900);
  const btn = await rectOf(page, '#subscribe');
  const pt = centre(btn);
  const start = (await send({ op: 'state' })).pose.body;
  const t0 = Date.now();
  const flight = await sample(send, () => send({ op: 'approach', point: pt, rect: btn, capMs: 900 }), 600);
  const ack = flight.result;
  const arrive = flight.out.find(o => o.events.some(e => e.op === 'arrive' && e.t >= t0));
  const flightMs = arrive ? arrive.events.filter(e => e.op === 'arrive').at(-1).t - t0 : null;
  st = await send({ op: 'state' });
  const handErr = Math.max(...st.pose.hands.map(h => dist(h, pt)));
  checks.record(
    'C6',
    'approach: arrives at the button under the cap, both hands on the click point',
    ack.arrived === true && flightMs < 900 && handErr < 8,
    { startDistPx: r1(dist(start, pt)), flightMs, arrived: ack.arrived, handErrPx: r1(handErr) },
  );
  const dir = { x: (pt.x - start.x) / dist(start, pt), y: (pt.y - start.y) / dist(start, pt) };
  const goal = { x: pt.x - dir.x * 22, y: pt.y - dir.y * 22 };
  const along = p => (p.x - start.x) * dir.x + (p.y - start.y) * dir.y;
  const total = along(goal);
  const early = flight.out.filter(o => o.t - t0 < 90).map(o => along(o.pose.body));
  const pullBack = -Math.min(0, ...early);
  const overshoot = Math.max(...flight.out.map(o => along(o.pose.body))) - total;
  // Leg spread at the fastest moment of the flight: gathered (~50 px) vs standing (~88 px).
  const peak = flight.out.reduce((a, o) => (o.pose.speed > a.pose.speed ? o : a), flight.out[0]);
  const midSpread = peak.pose.speed > 600 ? Math.max(...peak.pose.feet.map(f => dist(f, peak.pose.body))) : null;
  const frames = flight.out.filter((o, i) => i === 0 || dist(o.pose.body, flight.out[i - 1].pose.body) > 0);
  const maxStep = Math.max(0, ...frames.slice(1).map((o, i) => dist(o.pose.body, frames[i].pose.body)));
  checks.record(
    'C7',
    'motion: anticipation (pull back), leap with gathered legs, one small overshoot, no jumps',
    pullBack >= 2 && pullBack <= 10 && overshoot >= 1 && overshoot <= 14 && midSpread !== null && midSpread < 62 && maxStep <= 80,
    {
      pullBackPx: r1(pullBack),
      overshootPx: r1(overshoot),
      legSpreadAtPeakSpeedPx: midSpread && r1(midSpread),
      peakSpeed: peak.pose.speed,
      maxFrameStepPx: r1(maxStep),
    },
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
    'strike (wind-up, jab) lands on the point, then a real click passes through the overlay',
    sAck.ok && topEl === 'subscribe' && lastClick?.id === 'subscribe' && counter.startsWith('1 ') && strikeEv &&
      dist(strikeEv.point, pt) < 1 && strikeEv.t <= lastClick.t,
    { elementFromPoint: topEl, clickTarget: lastClick?.id, counter, strikeBeforeClickMs: strikeEv ? lastClick.t - strikeEv.t : null },
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
  checks.record('C9', 'typing: text reaches the field while the hands drum on it', value === 'spider@example.com' && drum > 1, {
    value,
    handTravelPx: r1(drum),
  });

  // C10 — the owner's case: the agent's instant scroll_to_bottom. A cut: carried a little, feet re-grip, no stretched legs.
  await page.evaluate(() => document.activeElement?.blur());
  // Busy on a target (as during an action), so "returns" has a meaning.
  await send({ op: 'approach', point: { x: 640, y: 420 }, capMs: 900 });
  await sleep(150);
  const before = (await send({ op: 'state' })).pose.body;
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const right = await send({ op: 'state' });
  const after = await sample(send, null, 1100);
  const cutPoses = [right.pose, ...after.out.map(o => o.pose)];
  const worstStretch = Math.max(...cutPoses.map(p => p.maxStretch));
  const worstLeg = Math.max(...cutPoses.map(p => Math.max(...legLengths(p))));
  const vh = await page.evaluate(() => innerHeight);
  const inView = cutPoses.every(p => p.body.y > 0 && p.body.y < vh);
  const back = dist(after.out.at(-1).pose.body, before);
  checks.record(
    'C10',
    'scroll to the bottom: no leg ever longer than its bones, body stays on screen and returns',
    worstStretch <= 1 && worstLeg <= MAX_LEG + 1 && inView && back < 12,
    { worstStretch, longestDrawnLegPx: r1(worstLeg), bodyStayedOnScreen: inView, returnedWithinPx: r1(back), samples: cutPoses.length },
  );

  // C10b — a small wheel scroll is walked, not cut.
  const cutsBefore = (await send({ op: 'state' })).events.filter(e => e.op === 'scroll-cut').length;
  const wheel = await sample(send, async () => {
    for (let i = 0; i < 14; i++) {
      await page.mouse.wheel(0, -18);
      await sleep(30);
    }
  }, 800);
  const cutsAfter = (await send({ op: 'state' })).events.filter(e => e.op === 'scroll-cut').length;
  const worstWheel = wheel.out.reduce((a, o) => (o.pose.maxStretch > a.pose.maxStretch ? o : a), wheel.out[0]);
  const wheelStretch = worstWheel.pose.maxStretch;
  checks.record(
    'C10b',
    'small wheel scroll: walked (feet ride the page and step), no cut, no overstretch',
    cutsAfter === cutsBefore && wheelStretch <= 1,
    { cuts: cutsAfter - cutsBefore, worstStretch: wheelStretch, worstAtMode: worstWheel.pose.mode, worstAtSpeed: worstWheel.pose.speed },
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(900);

  // C11 — background tab: no animation frames, the approach must not wait. Headless keeps tabs visible.
  await ext.bringToFront();
  await sleep(400);
  const visibility = await page.evaluate(() => document.visibilityState);
  if (visibility === 'hidden') {
    const t1 = Date.now();
    const hAck = await send({ op: 'approach', point: { x: 300, y: 300 }, capMs: 900 });
    const hiddenMs = Date.now() - t1;
    checks.record('C11', 'background tab: approach resolves at once (no waiting on frames)', hiddenMs < 300 && hAck.arrived === false, {
      visibility,
      ms: hiddenMs,
      reason: hAck.reason,
    });
  } else {
    checks.skip('C11', 'background tab: approach resolves at once', 'headless keeps background tabs visible; run with --headed');
  }
  await page.bringToFront();
  await sleep(600);

  // C12 — knees fan out and keep their order: per side, knee directions (relative to the heading)
  // stay strictly ordered head to tail, at least 0.2 rad apart — a knee never lands on a neighbour.
  // C23 — legs never touch: no two legs of a side come within 2 px of each other away from the body.
  {
    const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
    let disorder = 0;
    let minGap = Infinity;
    let touches = 0;
    let closest = Infinity;
    const touchBy = {};
    const segDist = (p, a, b) => {
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / (abx * abx + aby * aby || 1)));
      return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
    };
    // Sample each leg's drawn polyline away from the body (beyond 14 px of the hip).
    const pointsOf = (p, i) => {
      const pts = [];
      for (const [a, b] of [
        [p.hips[i], p.knees[i]],
        [p.knees[i], p.feet[i]],
      ]) {
        for (let k = 0; k <= 8; k++) {
          const q = { x: a.x + ((b.x - a.x) * k) / 8, y: a.y + ((b.y - a.y) * k) / 8 };
          if (dist(q, p.hips[i]) > 14) pts.push(q);
        }
      }
      return pts;
    };
    for (const p of allPoses) {
      if (!p.mode.startsWith('idle') && p.mode !== 'busy') continue;
      for (const side of [0, 1]) {
        const idx = [0, 1, 2, 3].map(i => i + side * 4);
        const ang = idx.map(i => Math.abs(wrap(Math.atan2(p.knees[i].y - p.body.y, p.knees[i].x - p.body.x) - p.heading)));
        for (let j = 1; j < 4; j++) {
          if (ang[j] <= ang[j - 1]) disorder++;
          minGap = Math.min(minGap, ang[j] - ang[j - 1]);
        }
        for (let j = 0; j < 3; j++) {
          const a = idx[j];
          const b = idx[j + 1];
          const segsB = [
            [p.hips[b], p.knees[b]],
            [p.knees[b], p.feet[b]],
          ];
          for (const q of pointsOf(p, a)) {
            const d = Math.min(...segsB.map(([u, v]) => segDist(q, u, v)));
            closest = Math.min(closest, d);
            if (d < 2) {
              touches++;
              const key = `${p.mode}|legs${a % 4}-${b % 4}|${p.speed > 40 ? 'moving' : 'still'}`;
              touchBy[key] = (touchBy[key] ?? 0) + 1;
            }
          }
        }
      }
    }
    checks.record('C12', 'knees fan out in order, never on a neighbour (idle and busy samples)', disorder === 0 && minGap >= 0.15 && allPoses.length > 200, {
      outOfOrder: disorder,
      minKneeGapRad: r1(minGap * 10) / 10,
      samples: allPoses.length,
    });
    checks.record('C23', 'legs never touch each other away from the body', touches === 0, {
      touchingPoints: touches,
      closestPx: r1(closest),
      where: Object.entries(touchBy).sort((x, y) => y[1] - x[1]).slice(0, 8),
    });
  }

  // C19 — moods: waiting = still with a tapping leg; asking = turned to the side panel; done = a full turn.
  await sleep(1600);
  await send({ op: 'mood', mood: 'waiting' });
  const waitS = await sample(send, null, 1200);
  // Measured after the body has had 400 ms to stop.
  const waitStill = Math.max(...waitS.out.filter(o => o.t - waitS.out[0].t > 400).map(o => o.pose.speed));
  const frontFeet = waitS.out.map(o => [o.pose.feet[0], o.pose.feet[4]]);
  const tapTravel = Math.max(...frontFeet.map(f => Math.max(dist(f[0], frontFeet[0][0]), dist(f[1], frontFeet[0][1]))));
  await send({ op: 'mood', mood: 'asking' });
  await sleep(1000);
  const ask = (await send({ op: 'state' })).pose;
  const askHeading = Math.atan2(Math.sin(ask.heading), Math.cos(ask.heading));
  const h0 = ask.heading;
  await send({ op: 'mood', mood: 'done' });
  await sleep(900);
  const turned = (await send({ op: 'state' })).pose.heading - h0;
  checks.record(
    'C19',
    'moods: waiting holds still with a tapping front leg; asking faces the side panel; done turns a full circle',
    waitStill < 30 && tapTravel > 4 && Math.abs(askHeading) < 0.25 && ask.mode === 'idle:asking' && turned > 5.5,
    { waitingMaxSpeed: Math.round(waitStill), frontFootTapPx: r1(tapTravel), askingHeading: r1(askHeading), doneTurnRad: r1(turned) },
  );
  await send({ op: 'mood', mood: 'thinking' });

  // C13 — depart: tuck and collapse into a point; the next action brings it back.
  const d0 = Date.now();
  const dAck = await send({ op: 'depart' });
  const departMs = Date.now() - d0;
  const gone = await send({ op: 'state' });
  const back2 = await send({ op: 'approach', point: { x: 500, y: 300 }, capMs: 1200 });
  checks.record(
    'C13',
    'depart: collapses in ~0.2 s, invisible after; the next action pops it back and it arrives',
    departMs >= 150 && departMs <= 400 && dAck.visible === false && gone.pose.scale === 0 && back2.arrived === true,
    { departMs, scaleAfter: gone.pose.scale, comesBackAndArrives: back2.arrived },
  );

  // C14 — teleport arrival on a "new page": same spot and heading, ring closes, pops with an overshoot, no descent.
  await send({ op: 'leave' });
  await sleep(1600);
  const place = { x: 420, y: 380, heading: 0.7 };
  const tp = await sample(send, () => send({ op: 'spawn', look: LOOK, at: place, arrive: 'teleport' }), 650);
  const scales = tp.out.map(o => o.pose.scale);
  // The pose right after the arrival finished (it looks around ~0.7 s before moving on).
  const tpEnd = (tp.out.find(o => o.events.some(e => e.op === 'arrived-teleport' && e.t >= tp.out[0].t)) ?? tp.out.at(-1)).pose;
  const tpEvents = tp.out.at(-1).events;
  const sinceSpawn = tpEvents.slice(tpEvents.findLastIndex(e => e.op === 'spawn-teleport'));
  checks.record(
    'C14',
    'teleport arrival: exact spot and heading, from 0 to an overshoot and back to 1, no thread descent',
    Math.min(...scales) === 0 && Math.max(...scales) >= 1.03 && Math.max(...scales) <= 1.15 && tpEnd.scale === 1 &&
      dist(tpEnd.body, place) < 2 && Math.abs(tpEnd.heading - place.heading) < 0.1 && !sinceSpawn.some(e => e.op === 'landed'),
    { minScale: Math.min(...scales), peakScale: Math.max(...scales), endScale: tpEnd.scale, bodyOffPx: r1(dist(tpEnd.body, place)), heading: tpEnd.heading },
  );

  // C15 — screenshots: hidden spider and torn words leave no pixel; the check itself can see them.
  await send({ op: 'approach', point: { x: 700, y: 360 }, capMs: 900 });
  await sleep(1300);
  await send({ op: 'focus', words: ['spider', 'press', 'isbn'] });
  let liveAtShot = 0;
  for (let i = 0; i < 50 && !liveAtShot; i++) {
    await sleep(200);
    liveAtShot = (await send({ op: 'state' })).stickers.length;
  }
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
    'C15',
    'hide before a screenshot: zero spider pixels (the same check sees it when visible)',
    dHidden.pixels === 0 && dVisible.pixels > 200 && liveAtShot >= 1,
    { tornWordsOnScreen: liveAtShot, pixelsWhenVisible: dVisible.pixels, pixelsWhenHidden: dHidden.pixels },
  );

  // C16 — leave: climbs away and removes its element.
  st = await send({ op: 'state' });
  checks.record('C16', 'leave: climbs out of view and removes the host element', !goneHost && st.events.at(-1)?.op === 'gone', {
    hostElement: goneHost,
    lastEvent: st.events.at(-1)?.op,
  });

  // C17 — navigation: the next page has a fresh content script and no overlay of its own.
  await page.click('#next');
  await page.waitForURL(/second\.html/);
  await sleep(800);
  const tab2 = await tabIdOf(ext, page.url());
  const st2 = await spider(ext, tab2)({ op: 'state' });
  const host2 = await page.evaluate(() => !!document.querySelector('browd-spider'));
  const appr = await spider(ext, tab2)({ op: 'approach', point: { x: 100, y: 100 }, capMs: 300 });
  checks.record(
    'C17',
    'after navigation: fresh content script, nothing drawn until told, commands report not-spawned',
    st2?.ok && !host2 && appr.reason === 'not-spawned',
    { contentScript: st2?.ok, hostElement: host2, approachReason: appr.reason },
  );

  // C21 — a heavy, never-still page (image grid, ~20k nodes, a style change every frame): the spider
  // reading and tearing must not cost frames. Layout is read once per block, never per step.
  await page.goto(`${base}/heavy.html`);
  await sleep(1500);
  const jank = async ms => {
    await page.evaluate(() => (window.__frames = []));
    await sleep(ms);
    return page.evaluate(() => {
      const f = window.__frames;
      return { frames: f.length, over24: f.filter(x => x > 24).length, worst: Math.round(Math.max(...f)) };
    });
  };
  const without = await jank(4000);
  const tab3 = await tabIdOf(ext, page.url());
  const send3 = spider(ext, tab3);
  await send3({ op: 'spawn', look: LOOK, at: { x: 500, y: 300, heading: 0 }, arrive: 'teleport' });
  await send3({ op: 'focus', words: ['spider', 'agent'] });
  await send3({ op: 'mood', mood: 'thinking' });
  await sleep(800);
  const withSpider = await jank(6000);
  const st3 = await send3({ op: 'state' });
  checks.record(
    'C21',
    'heavy page: the spider reading and tearing drops no more frames than the page alone',
    withSpider.over24 <= without.over24 + 2 && st3.frameMs < 20,
    { pageAlone: without, withSpider, spiderFrameMs: r1(st3.frameMs), blocksRead: st3.events.filter(e => e.op === 'read').length },
  );
  await send3({ op: 'leave' });

  await page.close();
  await ext.close();
} finally {
  await ctx.close();
}

// C18 — prefers-reduced-motion: no flight, no thread, no reading walk; jumps straight to the target.
{
  const { ctx: rctx, extId: rid } = await launch({ headless: !HEADED, reducedMotion: 'reduce' });
  try {
    const ext = await extensionPage(rctx, rid);
    const page = await rctx.newPage();
    await page.goto(`${base}/article.html`);
    await page.bringToFront();
    const send = spider(ext, await tabIdOf(ext, page.url()));
    await send({ op: 'spawn', look: LOOK, at: { x: 600, y: 300, heading: 0 }, arrive: 'descend' });
    const t0 = Date.now();
    const a = await send({ op: 'approach', point: { x: 300, y: 500 }, capMs: 900 });
    const ms = Date.now() - t0;
    await sleep(2500);
    const st = await send({ op: 'state' });
    const animated = st.events.some(e => e.op === 'landed' || e.op === 'read');
    checks.record(
      'C18',
      'reduced motion: no descent, no reading walk, approach jumps without waiting',
      a.reason === 'reduced-motion' && ms < 200 && !animated && st.pose.speed === 0,
      { reason: a.reason, ms, animatedMoves: animated, speed: st.pose.speed },
    );
  } finally {
    await rctx.close();
  }
}

server.close();

// Video → mp4 + contact sheet for a quick look.
const vids = fs.existsSync(path.join(OUT, 'video')) ? fs.readdirSync(path.join(OUT, 'video')) : [];
const webm = vids.map(f => path.join(OUT, 'video', f)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
if (webm) {
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', path.join(OUT, 'e2e.mp4')]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(OUT, 'e2e.mp4'), '-vf', 'fps=1,scale=480:-1,tile=6x5', '-frames:v', '1', path.join(OUT, 'e2e-sheet.png')]);
  } catch (e) {
    console.log(`ffmpeg skipped: ${e.message.split('\n')[0]}`);
  }
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ when: new Date().toISOString(), checks: checks.rows }, null, 2));
const ran = checks.rows.filter(r => r.pass !== null).length;
console.log(`\n${ran - checks.failed.length}/${ran} passed, ${checks.rows.length - ran} skipped → ${OUT}`);
process.exit(checks.failed.length ? 1 : 0);
