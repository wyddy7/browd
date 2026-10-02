// Headed Chromium with the real side panel: the spider crosses the page ↔ panel seam slowly while the
// window is captured with macOS `screencapture` every ~0.2 s (needs Screen Recording permission).
// The real side panel only opens on a user gesture: the script clicks a button in an extension page.
//
//   pnpm build && (cd bench/spider && node seam-live.mjs /tmp/seam)   # then: touch /tmp/seam
// Frames: /tmp/seam-shot-NNN.png, timing: /tmp/seam-shots.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { EXT, serveFixtures, sleep, spider, tabIdOf } from './lib.mjs';
const GO = process.argv[2];
const LOG = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const { server, base } = await serveFixtures();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browd-seam-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false, channel: 'chromium', viewport: null,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--window-position=40,40', '--window-size=1400,880'],
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(`${base}/article.html`);
const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/options/index.html`);
const windowId = await ext.evaluate(async () => (await chrome.windows.getCurrent()).id);
await ext.evaluate(id => {
  const b = document.createElement('button');
  b.id = 'open-panel'; b.textContent = 'open panel';
  b.style.cssText = 'position:fixed;top:10px;left:10px;z-index:99999;padding:20px';
  b.onclick = () => chrome.sidePanel.open({ windowId: id });
  document.body.appendChild(b);
}, windowId);
await ext.click('#open-panel');
await sleep(1500);
await page.bringToFront();
await sleep(800);
const tabId = await tabIdOf(ext, page.url());
const send = spider(ext, tabId);
const toPanel = msg => ext.evaluate(m => chrome.runtime.sendMessage(m), { type: 'browd:spider:panel', ...msg });
const LOOK = { size: 1.3, pace: 'normal', marks: 'target', color: 'magenta', tear: false };
await send({ op: 'spawn', look: LOOK, at: { x: 700, y: 420, heading: 0 }, arrive: 'teleport' });
await sleep(1200);
const pm = (await send({ op: 'metrics' })).metrics;
const sm = (await toPanel({ op: 'metrics' })).metrics;
const zoom = await ext.evaluate(id => chrome.tabs.getZoom(id), tabId);
LOG('page', JSON.stringify(pm), 'panel', JSON.stringify(sm), 'zoom', zoom);
// background/browser/portal.ts, inline
const screenScale = pm.dpr / zoom, zp = sm.dpr / screenScale, k = zoom / zp;
const pageW = pm.width * zoom, panelW = sm.width * zp;
const spare = pm.outerWidth - pageW - panelW; const m = spare > 0 && spare < 80 ? spare / 2 : 0;
const panelLeft = (sm.side ?? 'right') === 'right' ? pageW + m : -(panelW + m);
const toSeat = p => ({ x: (p.x * zoom - panelLeft) / zp, y: sm.height - ((pm.height - p.y) * zoom - m) / zp });
const toPg = q => ({ x: (q.x * zp + panelLeft) / zoom, y: pm.height - ((sm.height - q.y) * zp + m) / zoom });
LOG('k', k.toFixed(3), 'margin', m.toFixed(1), 'side', sm.side);
const win = await ext.evaluate(async id => { const w = await chrome.windows.get(id); return { left: w.left, top: w.top, width: w.width, height: w.height }; }, windowId);
const { execFile } = await import('node:child_process');
const shots = [];
let shooting = true;
const shoot = async () => { let i = 0; while (shooting) { const f = `${GO}-shot-${String(i++).padStart(3, '0')}.png`; await new Promise(r => execFile('screencapture', ['-x', '-R', `${win.left},${win.top},${win.width},${win.height}`, f], r)); shots.push({ f, t: Date.now() }); } };
const seat = { x: 140, y: Math.round(sm.height * 0.55) };
const T = Number(process.env.T ?? 9000);
const shooter = shoot();
const out = await send({ op: 'crossOut', to: toPg(seat), T, bow: 0 });
const plan = out.cross.plan;
await toPanel({ op: 'crossIn', plan: { ...plan, from: toSeat(plan.from), to: seat, v0: { x: plan.v0.x * k, y: plan.v0.y * k }, size: plan.size * k }, look: LOOK });
LOG('crossing started', JSON.stringify({ from: plan.from, to: plan.to, T }));
await sleep(T + 1500);
shooting = false;
await shooter;
fs.writeFileSync(`${GO}-shots.json`, JSON.stringify({ shots, t0: plan.t0, T, win, pm, sm, k, m }));
await ctx.close(); server.close();
LOG('done');
