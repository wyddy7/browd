// A choreographed run for reviewing the motion: entrance on a thread,
// reading between actions, a leap to a button and a tap, typing, a big
// scroll and a small one, leaving the page and teleporting onto the next.
// Records a video and dense frame strips of each beat.
//
//   pnpm build && (cd bench/spider && node demo.mjs [--marks feet] [--size 1.35])
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, extensionPage, launch, serveFixtures, sleep, spider, stamp, tabIdOf } from './lib.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const LOOK = { size: Number(arg('size', '1')), pace: arg('pace', 'normal'), marks: arg('marks', 'target'), color: arg('color', 'violet'), tear: arg('tear', 'on') !== 'off' };
const OUT = path.join(ROOT, 'bench-runs', 'spider-demo', stamp());
fs.mkdirSync(OUT, { recursive: true });

const { server, base } = await serveFixtures();
const { ctx, extId } = await launch({ video: path.join(OUT, 'video') });
const beats = [];
let t0 = 0;
const beat = name => beats.push({ name, t: (Date.now() - t0) / 1000 });
const centre = (page, sel) =>
  page.evaluate(s => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { point: { x: r.x + r.width / 2, y: r.y + r.height / 2 }, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  }, sel);

try {
  const ext = await extensionPage(ctx, extId);
  const page = await ctx.newPage();
  t0 = Date.now(); // the page's video starts with the page
  await page.goto(`${base}/article.html`);
  await page.bringToFront();
  let send = spider(ext, await tabIdOf(ext, page.url()));

  beat('descend');
  await send({ op: 'spawn', look: LOOK, at: { x: 760, y: 300, heading: 0 }, arrive: 'descend' });
  await sleep(1500);
  beat('read-tear');
  await send({ op: 'focus', words: ['spider', 'press', 'isbn'] });
  await send({ op: 'mood', mood: 'thinking' });
  await sleep(7000);
  await send({ op: 'mood', mood: 'acting' });

  beat('leap-strike');
  const sub = await centre(page, '#subscribe');
  await send({ op: 'approach', ...sub, capMs: 900 });
  await send({ op: 'strike', ...sub });
  await page.mouse.click(sub.point.x, sub.point.y);
  await sleep(700);

  beat('type');
  const email = await centre(page, '#email');
  await send({ op: 'approach', ...email, capMs: 900 });
  await send({ op: 'strike', ...email });
  await page.mouse.click(email.point.x, email.point.y);
  await send({ op: 'typing', on: true });
  await page.keyboard.type('spider@example.com', { delay: 45 });
  await send({ op: 'typing', on: false });
  await page.evaluate(() => document.activeElement?.blur());
  await sleep(900);

  beat('scroll-big');
  await page.evaluate(() => window.scrollBy(0, 1600));
  await sleep(1400);
  beat('scroll-small');
  for (let i = 0; i < 16; i++) {
    await page.mouse.wheel(0, 28);
    await sleep(30);
  }
  await sleep(1200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(1000);

  beat('depart');
  const next = await centre(page, '#next');
  await send({ op: 'approach', ...next, capMs: 900 });
  await send({ op: 'strike', ...next });
  const place = (await send({ op: 'state' })).pose;
  await send({ op: 'mood', mood: 'waiting' });
  const departing = send({ op: 'depart' });
  await sleep(230);
  await departing;
  await page.goto(`${base}/second.html`);
  beat('teleport-in');
  send = spider(ext, await tabIdOf(ext, page.url()));
  await send({ op: 'spawn', look: LOOK, at: { x: place.body.x, y: place.body.y, heading: place.heading }, arrive: 'teleport', mood: 'waiting' });
  await sleep(1300);
  beat('asking');
  await send({ op: 'mood', mood: 'asking' });
  await sleep(1500);
  await send({ op: 'mood', mood: 'acting' });
  beat('strike-light');
  const join = await centre(page, '#join-button');
  await send({ op: 'approach', ...join, capMs: 900 });
  await send({ op: 'strike', ...join });
  await sleep(1500);
  beat('done-leave');
  await send({ op: 'mood', mood: 'done' });
  await send({ op: 'leave' });
  await sleep(1500);
  await page.close();
  await ext.close();
} finally {
  await ctx.close();
  server.close();
}

const vdir = path.join(OUT, 'video');
const webm = fs
  .readdirSync(vdir)
  .map(f => path.join(vdir, f))
  .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
const mp4 = path.join(OUT, `demo-${LOOK.marks}.mp4`);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', mp4]);
// Dense strips: 12 frames at 20 fps from the start of each beat, cropped around the action.
for (const b of beats) {
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-ss', String(Math.max(0, b.t - 0.05)), '-i', mp4,
    '-vf', 'fps=20,scale=640:-1,tile=6x2', '-frames:v', '1',
    path.join(OUT, `strip-${b.name}.png`),
  ]);
}
fs.writeFileSync(path.join(OUT, 'beats.json'), JSON.stringify(beats, null, 2));
console.log(OUT);
