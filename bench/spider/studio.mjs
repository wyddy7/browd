// Close-up stills of the spider for a design check: rest, walk, read,
// strike, teleport in and out, on the dark fixture and on the light one.
// 3x device pixels so the shape can be judged.
//
//   pnpm build && (cd bench/spider && node studio.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { EXT, ROOT, serveFixtures, sleep, stamp } from './lib.mjs';
import os from 'node:os';

const OUT = path.join(ROOT, 'bench-runs', 'spider-studio', stamp());
fs.mkdirSync(OUT, { recursive: true });
const LOOK = { size: Number(process.argv[2] ?? 1), pace: 'normal', marks: 'target', color: process.argv[3] ?? 'violet', tear: true };

const { server, base } = await serveFixtures();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browd-studio-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: 'chromium',
  viewport: { width: 1000, height: 700 },
  deviceScaleFactor: 3,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${extId}/options/index.html`);
  const shots = [];
  for (const fixture of ['article.html', 'second.html']) {
    const page = await ctx.newPage();
    await page.goto(`${base}/${fixture}`);
    await page.bringToFront();
    const tabId = await ext.evaluate(async u => (await chrome.tabs.query({})).find(t => t.url === u).id, page.url());
    const send = cmd =>
      ext.evaluate(({ tabId, cmd }) => chrome.tabs.sendMessage(tabId, { type: 'browd:spider', cmd }, { frameId: 0 }), {
        tabId,
        cmd,
      });
    const snap = async (name, around) => {
      const st = await send({ op: 'state' });
      const c = around ?? st.pose.body;
      const file = path.join(OUT, `${fixture.replace('.html', '')}-${name}.png`);
      await page.screenshot({ path: file, clip: { x: Math.max(0, c.x - 160), y: Math.max(0, c.y - 130), width: 320, height: 260 } });
      shots.push(file);
      return st;
    };
    await send({ op: 'spawn', look: LOOK, at: { x: 520, y: 330, heading: 0 }, arrive: 'teleport' });
    await sleep(160);
    await snap('teleport-in-early');
    await sleep(110);
    await snap('teleport-in-pop');
    await sleep(900);
    await snap('rest');
    const btn = await page.evaluate(() => {
      const el = document.querySelector('#subscribe, #join-button');
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height, rx: r.x, ry: r.y };
    });
    const go = send({ op: 'approach', point: { x: btn.x, y: btn.y }, capMs: 900 });
    await sleep(170);
    await snap('walk');
    await go;
    await sleep(250);
    const strike = send({ op: 'strike', point: { x: btn.x, y: btn.y } });
    await sleep(40);
    await snap('strike-windup');
    await strike;
    await snap('strike-contact');
    await sleep(2500);
    await snap('idle-read-or-look');
    const dep = send({ op: 'depart' });
    await sleep(120);
    await snap('depart-mid');
    await dep;
    await send({ op: 'leave' });
    await page.close();
  }
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    ...shots.flatMap(f => ['-i', f]),
    '-filter_complex', `${shots.map((_, i) => `[${i}]scale=440:-1[s${i}]`).join(';')};${shots.map((_, i) => `[s${i}]`).join('')}xstack=inputs=${shots.length}:layout=${layout(shots.length, 8)}`,
    path.join(OUT, 'sheet.png'),
  ]);
  console.log(OUT);
} finally {
  await ctx.close();
  server.close();
}

function layout(n, cols) {
  const cells = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    cells.push(`${c === 0 ? '0' : Array.from({ length: c }, () => 'w0').join('+')}_${r === 0 ? '0' : Array.from({ length: r }, () => 'h0').join('+')}`);
  }
  return cells.join('|');
}
