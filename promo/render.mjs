// Renders promo/scene.html to MP4 in both formats, frame by frame, using the
// system Chrome (via playwright-core) and ffmpeg.
//
//   node promo/render.mjs            # promo/out/tui2web-{landscape,vertical}.mp4
//   node promo/render.mjs --stills   # a few PNG frames per format, for checking
//
// If promo/music.mp3 exists it's mixed in (faded in and out). It's git-ignored:
// licensed music can't be redistributed on its own. The current cut of
// "Lofi Hip Hop Funky Midnight Club" (alex-morgan, Pixabay) puts the beat
// coming back after the breakdown on the reveal; the scene's beat grid
// (REVEAL/BEAT in scene.html) matches its 86.7 BPM:
//   ffmpeg -ss 92.12 -t 20 -i promo/music.source.mp3 promo/music.mp3
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FPS = 30;
const FORMATS = { landscape: [1920, 1080], vertical: [1080, 1920] };
const STILLS = [1.2, 3.2, 4.3, 5.5, 8.6, 11.5, 13, 17];
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
}

await browser.close();
