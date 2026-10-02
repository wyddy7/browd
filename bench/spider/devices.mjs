// The e2e checks (tier A) as several devices: screen size, pixel ratio, page zoom. Prints one line per device.
//
//   pnpm build && (cd bench/spider && node devices.mjs)
import { execFileSync } from 'node:child_process';

const DEVICES = [
  { name: 'laptop 1280×800 @1x', viewport: '1280x800', dpr: 1 },
  { name: 'retina 1280×800 @2x', viewport: '1280x800', dpr: 2 },
  { name: 'MacBook Air 1440×900 @2x', viewport: '1440x900', dpr: 2 },
  { name: 'laptop 1366×768 @1x', viewport: '1366x768', dpr: 1 },
  { name: 'desktop 1920×1080 @1x', viewport: '1920x1080', dpr: 1 },
  { name: 'desktop 1920×1080 @1x, page zoom 150 %', viewport: '1920x1080', dpr: 1, zoom: 1.5 },
  { name: '4K-ish 2560×1440 @2x', viewport: '2560x1440', dpr: 2 },
];

const only = process.argv[2];
for (const d of DEVICES.filter(x => !only || x.name.includes(only))) {
  const env = { ...process.env, SPIDER_VIEWPORT: d.viewport, SPIDER_DPR: String(d.dpr), ...(d.zoom ? { SPIDER_ZOOM: String(d.zoom) } : {}) };
  let out = '';
  try {
    out = execFileSync('node', ['e2e.mjs'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 400_000 });
  } catch (e) {
    out = `${e.stdout ?? ''}`;
  }
  const summary = out.split('\n').find(l => /passed/.test(l)) ?? 'no summary';
  const fails = out.split('\n').filter(l => l.startsWith('FAIL')).map(l => l.slice(0, 220));
  console.log(`${d.name}: ${summary.replace(/ → .*/, '')}`);
  for (const f of fails) console.log(`   ${f}`);
}
