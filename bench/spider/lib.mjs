// Shared harness for the spider e2e checks: a static server for the
// fixtures, a Chromium with the built extension, and a way to talk to the
// content script exactly as the background does (chrome.tabs.sendMessage
// to frame 0) from an extension page.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../..');
export const EXT = path.join(ROOT, 'dist');

export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export function serveFixtures(dir = path.join(HERE, 'fixtures'), extra = () => false) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    if (extra(req, res)) return;
    const url = new URL(req.url, 'http://x');
    const file = path.join(dir, path.normalize(url.pathname).replace(/^\/+/, '') || 'article.html');
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

let debugPort = 9500 + Math.floor(Math.random() * 400);

export async function launch({ headless = true, video = null, reducedMotion = 'no-preference', viewport, swLog = false } = {}) {
  if (!fs.existsSync(path.join(EXT, 'manifest.json'))) throw new Error(`no build at ${EXT} — run pnpm build first`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browd-spider-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless,
    channel: 'chromium',
    viewport: viewport ?? { width: 1280, height: 800 },
    reducedMotion,
    ...(video ? { recordVideo: { dir: video, size: viewport ?? { width: 1280, height: 800 } } } : {}),
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--window-position=2600,0',
      ...(swLog ? [`--remote-debugging-port=${++debugPort}`] : []),
    ],
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 30_000 }));
  const extId = new URL(sw.url()).host;
  const swLines = [];
  if (swLog) await tapServiceWorkerConsole(debugPort, extId, swLines);
  return { ctx, extId, profile, swLines };
}

/**
 * Playwright does not surface MV3 service-worker console here, so read it
 * over the worker's own CDP WebSocket (same approach as bench/om2w --sw-log).
 */
async function tapServiceWorkerConsole(port, extId, lines) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find(x => x.type === 'service_worker' && x.url.includes(extId));
  if (!target) return;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
      resolve();
    };
  });
  ws.onmessage = m => {
    const msg = JSON.parse(m.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      lines.push({ t: Date.now(), text: msg.params.args.map(a => a.value ?? a.description ?? '').join(' ') });
    }
  };
}

/** An extension page that can reach chrome.tabs / chrome.storage. */
export async function extensionPage(ctx, extId, page = 'options/index.html') {
  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${extId}/${page}`);
  return ext;
}

export async function tabIdOf(ext, url) {
  return ext.evaluate(async u => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find(x => x.url === u);
    return t ? t.id : null;
  }, url);
}

/** Send one spider command to the content script of `tabId`, as the background would. */
export function spider(ext, tabId) {
  return cmd =>
    ext.evaluate(
      ({ tabId, cmd }) => chrome.tabs.sendMessage(tabId, { type: 'browd:spider', cmd }, { frameId: 0 }),
      { tabId, cmd },
    );
}

/**
 * Count pixels that differ between two PNG buffers (per-channel delta > tol),
 * decoded in an extension page's canvas — no image library needed.
 */
export async function pixelDiff(ext, a, b, tol = 8) {
  return ext.evaluate(
    async ({ a, b, tol }) => {
      const load = src =>
        new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = rej;
          img.src = `data:image/png;base64,${src}`;
        });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const w = Math.min(ia.width, ib.width);
      const h = Math.min(ia.height, ib.height);
      const data = img => {
        const c = new OffscreenCanvas(w, h);
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, w, h).data;
      };
      const da = data(ia);
      const db = data(ib);
      let n = 0;
      let x0 = w;
      let y0 = h;
      let x1 = -1;
      let y1 = -1;
      for (let i = 0; i < da.length; i += 4) {
        if (
          Math.abs(da[i] - db[i]) > tol ||
          Math.abs(da[i + 1] - db[i + 1]) > tol ||
          Math.abs(da[i + 2] - db[i + 2]) > tol
        ) {
          n++;
          const p = i / 4;
          const x = p % w;
          const y = (p - x) / w;
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
      return { pixels: n, box: n ? [x0, y0, x1, y1] : null };
    },
    { a: a.toString('base64'), b: b.toString('base64'), tol },
  );
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Checks {
  constructor() {
    this.rows = [];
  }
  record(id, name, pass, measured, expected) {
    this.rows.push({ id, name, pass: !!pass, measured, expected });
    const mark = pass ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${id.padEnd(4)} ${name} — ${typeof measured === 'string' ? measured : JSON.stringify(measured)}`);
  }
  skip(id, name, why) {
    this.rows.push({ id, name, pass: null, measured: `skipped: ${why}` });
    console.log(`SKIP  ${id.padEnd(4)} ${name} — ${why}`);
  }
  get failed() {
    return this.rows.filter(r => r.pass === false);
  }
}
