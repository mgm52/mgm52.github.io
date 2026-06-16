// Renders each gooey-shader isolation test (goo-tests/*.html) to its own
// smooth mp4 under videos/goo/, plus a few inspection frames in
// goo-tests/frames/.
//
//   node scripts/record-goo-tests.mjs            # all variations
//   node scripts/record-goo-tests.mjs v2 v4      # a subset (by file stem)
//
// These run in a software-WebGL sandbox (swiftshader) where the shaders
// paint at only ~7-15 fps, so instead of screen-recording in real time we
// drive each page deterministically: stop its live clock, step the
// animation one frame at a time via window.GOO.seek(t), screenshot each
// frame, then assemble the PNGs at a constant FPS with ffmpeg. The result
// is perfectly smooth and reproducible regardless of GPU speed.
//
// Pages load over file:// — every test is self-contained (inline shader +
// shared card.js/gl.js), so no dev server is needed.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TESTS = path.join(ROOT, 'goo-tests');
const OUT = path.join(ROOT, 'videos', 'goo');
const FRAMES = path.join(TESTS, 'frames');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(FRAMES, { recursive: true });

const EXE = process.env.CHROME_EXE || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FF = (await import('ffmpeg-static')).default;
const FPS = Number(process.env.FPS ?? 30);
const NFRAMES = Number(process.env.NFRAMES ?? 165);   // ~5.5s at 30fps
const W = 760, H = 950;

const filter = process.argv.slice(2);
let files = fs.readdirSync(TESTS)
  .filter((f) => /^v\d.*\.html$/.test(f))
  .sort();
if (filter.length) files = files.filter((f) => filter.some((s) => f.startsWith(s)));
if (!files.length) { console.error('no matching test pages'); process.exit(1); }
console.log('rendering:', files.join(', '));

const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--no-sandbox'],
});

for (const file of files) {
  const stem = file.replace(/\.html$/, '');
  console.log(`\n── ${stem} ──`);
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('  PAGEERROR:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('  console.error:', m.text()); });

  await page.goto(pathToFileURL(path.join(TESTS, file)).href, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(() => window.GOO && window.GOO.ready, { timeout: 20000 });
  } catch {
    console.log('  WARN: window.GOO never became ready (title=' + (await page.title()) + ')');
  }
  const dt = await page.evaluate(() => (window.GOO && window.GOO.dt) || 1 / 30);
  await page.evaluate(() => window.GOO.stop());

  const frameDir = path.join(TESTS, '.frames-' + stem);
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });

  process.stdout.write('  stepping frames: ');
  for (let i = 0; i < NFRAMES; i++) {
    await page.evaluate((t) => window.GOO.seek(t), i * dt);
    const buf = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
    fs.writeFileSync(path.join(frameDir, `f${String(i).padStart(4, '0')}.png`), buf);
    if (i % 30 === 0) process.stdout.write('.');
  }
  process.stdout.write(' done\n');
  await context.close();

  // assemble PNG sequence → smooth, constant-fps mp4
  const mp4 = path.join(OUT, `${stem}.mp4`);
  execFileSync(FF, ['-y', '-framerate', String(FPS), '-i', path.join(frameDir, 'f%04d.png'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-profile:v', 'high', '-level', '4.0', mp4], { stdio: 'ignore' });

  // a few inspection stills (early / mid / late)
  for (const [tag, idx] of [['a', 1], ['b', (NFRAMES / 2) | 0], ['c', NFRAMES - 2]]) {
    fs.copyFileSync(path.join(frameDir, `f${String(idx).padStart(4, '0')}.png`),
      path.join(FRAMES, `${stem}-${tag}.png`));
  }
  fs.rmSync(frameDir, { recursive: true, force: true });
  const kb = (fs.statSync(mp4).size / 1024) | 0;
  console.log(`  saved ${path.relative(ROOT, mp4)} (${kb} KB)`);
}

await browser.close();
console.log('\ndone.');
