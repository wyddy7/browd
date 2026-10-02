// Frame-by-frame strips of the spider's moves, captured from the page as
// they happen (clipped screenshots back to back, ~20–25 per second):
// leap + tap, a big scroll, a small scroll, depart, teleport in, reading.
//
//   pnpm build && (cd bench/spider && node motion.mjs)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { EXT, ROOT, serveFixtures, sleep, stamp } from './lib.mjs';

const OUT = path.join(ROOT, 'bench-runs', 'spider-motion', stamp());
fs.mkdirSync(OUT, { recursive: true });
const LOOK = { size: 1, pace: 'normal', marks: 'target', color: 'violet', tear: true };

const { server, base } = await serveFixtures();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browd-motion-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: 'chromium',
  viewport: { width: 1000, height: 700 },
  deviceScaleFactor: 1.5,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

async function strip(page, name, clip, ms, action) {
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  const t0 = Date.now();
  const run = action();
  while (Date.now() - t0 < ms) {
    const f = path.join(dir, `${String(files.length).padStart(3, '0')}.jpg`);
    await page.screenshot({ path: f, clip, type: 'jpeg', quality: 70 });
    files.push({ f, t: Date.now() - t0 });
  }
  await run;
  const every = files.length / 12;
  const pick = Array.from({ length: Math.min(12, files.length) }, (_, i) => files[Math.floor(i * Math.max(1, every))]);
  fs.writeFileSync(path.join(OUT, `${name}.times.txt`), pick.map(p => `${p.t}ms`).join(' '));
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    ...pick.flatMap(p => ['-i', p.f]),
    '-filter_complex',
    `${pick.map((_, i) => `[${i}]scale=320:-1[s${i}]`).join(';')};${pick.map((_, i) => `[s${i}]`).join('')}xstack=inputs=${pick.length}:layout=${grid(pick.length, 6)}`,
    path.join(OUT, `${name}.png`),
  ]);
  return files.length;
}

function grid(n, cols) {
  return Array.from({ length: n }, (_, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = c ? Array.from({ length: c }, () => 'w0').join('+') : '0';
    const y = r ? Array.from({ length: r }, () => 'h0').join('+') : '0';
    return `${x}_${y}`;
  }).join('|');
}

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${extId}/options/index.html`);
  const page = await ctx.newPage();
  await page.goto(`${base}/article.html`);
  await page.bringToFront();
  const tabOf = async () => ext.evaluate(async u => (await chrome.tabs.query({})).find(t => t.url === u).id, page.url());
  let tabId = await tabOf();
  const send = cmd =>
    ext.evaluate(({ tabId, cmd }) => chrome.tabs.sendMessage(tabId, { type: 'browd:spider', cmd }, { frameId: 0 }), {
      tabId,
      cmd,
    });
  const rect = sel =>
    page.evaluate(s => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, sel);
  const counts = {};

  counts.descend = await strip(page, 'descend', { x: 560, y: 0, width: 400, height: 420 }, 1400, () =>
    send({ op: 'spawn', look: LOOK, at: { x: 760, y: 300, heading: 0 }, arrive: 'descend' }),
  );
  await sleep(300);
  // Park it on the right, then leap to the button on the left.
  await send({ op: 'approach', point: { x: 820, y: 420 }, capMs: 900 });
  await sleep(1200);
  const btn = await rect('#subscribe');
  counts.leap = await strip(page, 'leap-strike', { x: 0, y: 40, width: 1000, height: 500 }, 1100, async () => {
    await send({ op: 'approach', point: btn, capMs: 900 });
    await send({ op: 'strike', point: btn });
  });
  await sleep(600);
  await send({ op: 'approach', point: { x: 500, y: 420 }, capMs: 900 });
  await sleep(1000);
  counts.scrollBig = await strip(page, 'scroll-big', { x: 300, y: 220, width: 400, height: 400 }, 1200, async () => {
    await sleep(120);
    await page.evaluate(() => window.scrollBy(0, 1600));
  });
  counts.scrollSmall = await strip(page, 'scroll-small', { x: 300, y: 220, width: 400, height: 400 }, 1200, async () => {
    for (let i = 0; i < 18; i++) {
      await page.mouse.wheel(0, 26);
      await sleep(25);
    }
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(1500);
  counts.read = await strip(page, 'read', { x: 0, y: 0, width: 1000, height: 700 }, 5000, () => sleep(10));
  const st = (await send({ op: 'state' })).pose;
  counts.depart = await strip(
    page,
    'depart',
    { x: Math.max(0, st.body.x - 150), y: Math.max(0, st.body.y - 150), width: 300, height: 300 },
    450,
    () => send({ op: 'depart' }),
  );
  const place = (await send({ op: 'state' })).pose;
  await page.goto(`${base}/second.html`);
  tabId = await tabOf();
  counts.teleport = await strip(
    page,
    'teleport-in',
    { x: Math.max(0, place.body.x - 150), y: Math.max(0, place.body.y - 150), width: 300, height: 300 },
    700,
    () => send({ op: 'spawn', look: LOOK, at: { x: place.body.x, y: place.body.y, heading: place.heading }, arrive: 'teleport' }),
  );
  console.log(JSON.stringify(counts));
  console.log(OUT);
} finally {
  await ctx.close();
  server.close();
}
