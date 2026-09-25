// Renders promo/scene.html to MP4 in both formats, frame by frame, using the
// system Chrome (via playwright-core) and ffmpeg.
//
//   node promo/render.mjs            # promo/out/tui2web-{landscape,vertical}.mp4, plus
//                                    # smaller web copies and posters for the landing page
//                                    # in packages/web/public/promo/
//   node promo/render.mjs --stills   # a few PNG frames per format, for checking
//
// If promo/music.mp3 exists it's mixed in (faded in and out). It's git-ignored:
// licensed music can't be redistributed on its own. The current cut of
// "Lofi Hip Hop Funky Midnight Club" (alex-morgan, Pixabay) puts the beat
// coming back after the breakdown on the reveal; the scene's beat grid
// (REVEAL/BEAT in scene.html) matches its 86.7 BPM:
//   ffmpeg -ss 92.12 -t 24 -i promo/music.source.mp3 promo/music.mp3
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FPS = 30;
const FORMATS = { landscape: [1920, 1080], vertical: [1080, 1920] };
const STILLS = [18.8, 20.3, 22.8];
const here = new URL('.', import.meta.url);
const out = new URL('out/', here);
const music = new URL('music.mp3', here);
mkdirSync(out, { recursive: true });

const stillsOnly = process.argv.includes('--stills');
const browser = await chromium.launch({ executablePath: CHROME });

for (const [format, [width, height]] of Object.entries(FORMATS)) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(new URL(`scene.html?format=${format}`, here).href);
  await page.evaluate(() => document.fonts.ready);
  const duration = await page.evaluate(() => window.DURATION);

  if (stillsOnly) {
    for (const t of STILLS) {
      await page.evaluate((t) => window.seek(t), t);
      await page.screenshot({ path: new URL(`still-${format}-${t}.png`, out).pathname });
    }
    console.log(`${format}: ${STILLS.length} stills in promo/out/`);
    continue;
  }

  const file = new URL(`tui2web-${format}.mp4`, out).pathname;
  const withMusic = existsSync(music);
  const ffmpeg = spawn('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    ...(withMusic ? ['-i', music.pathname] : []),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    ...(withMusic
      ? ['-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-af', `afade=t=in:d=0.5,afade=t=out:st=${duration - 2}:d=2`, '-t', String(duration)]
      : []),
    file,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  const frames = Math.round(duration * FPS);
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.seek(t), i / FPS);
    const jpeg = await page.screenshot({ type: 'jpeg', quality: 95 });
    if (!ffmpeg.stdin.write(jpeg)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
    if (i % FPS === 0) process.stdout.write(`\r${format}: ${Math.round((i / frames) * 100)}%`);
  }
  ffmpeg.stdin.end();
  const code = await new Promise((r) => ffmpeg.on('close', r));
  if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
  console.log(`\r${format}: ${file}${withMusic ? ' (with music)' : ' (no music: add promo/music.mp3)'}`);

  // Lighter copy and a poster frame for the landing page.
  const web = new URL(`../packages/web/public/promo/`, here);
  mkdirSync(web, { recursive: true });
  const scale = format === 'landscape' ? '1280:-2' : '720:-2';
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vf', `scale=${scale}`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '26',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', new URL(`${format}.mp4`, web).pathname]);
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '11.6', '-i', file, '-frames:v', '1', '-vf', `scale=${scale}`, '-q:v', '4',
    new URL(`${format}.jpg`, web).pathname]);
  console.log(`${format}: web copy in packages/web/public/promo/`);
}

await browser.close();

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}
