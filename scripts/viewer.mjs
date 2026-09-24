// The web viewer in a real (headless) Chrome: mouse events on the terminal
// must not claim the screen size, key presses must.
//   node scripts/viewer.mjs [relay-url]      (CHROME=/path/to/chrome to override)
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { CLI_ENTRY, CLI_NODE } from './cli-cmd.mjs';
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const WebSocket = require('ws');
const { pty } = await import('../packages/cli/src/pty.ts');

const RELAY = process.argv[2] ?? 'http://localhost:8787';
const CHROME = process.env.CHROME || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Laptop: the fake full-screen app turns on mouse tracking, like Claude Code.
let out = '';
const cli = pty.spawn(CLI_NODE, [CLI_ENTRY, '--relay', RELAY, '--no-qr', '--no-wait', 'node', 'scripts/fake-tui.mjs'], { cols: 120, rows: 40, cwd: process.cwd(), env: process.env });
cli.onData((d) => (out += d));
while (!/token=[\w-]+/.test(out)) await sleep(50);
const url = out.match(/http\S+token=[\w-]+/)[0];

// Watch size changes as a second viewer.
const u = new URL(url);
const cookie = (await fetch(url, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
const watcher = new WebSocket(`${u.origin.replace(/^http/, 'ws')}${u.pathname}/ws`, { headers: { cookie }, origin: u.origin });
const sizes = [];
watcher.on('message', (d, bin) => { if (!bin) { const m = JSON.parse(d.toString()); if (m.t === 'size') sizes.push(`${m.cols}x${m.rows}`); } });

// Phone: the real viewer page at phone size.
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: false });
await page.goto(url);
await page.waitForSelector('.xterm-screen');
await sleep(1500);
const phoneSize = sizes.at(-1);
check('opening the page claims a phone-sized screen', !!phoneSize && phoneSize !== '120x40', phoneSize);

cli.write('k'); // laptop types: laptop owns the size again
await sleep(600);
check('laptop key press takes the size back', sizes.at(-1) === '120x40', sizes.at(-1));

const box = await page.locator('.xterm-screen').boundingBox();
for (let i = 0; i < 5; i++) await page.mouse.click(box.x + 20 + i * 10, box.y + 30);
await sleep(800);
check('clicking on the terminal in the browser does not claim the size', sizes.at(-1) === '120x40', sizes.at(-1));
// fake-tui shows the last input as JSON; SGR mouse reports start with ESC [ <
check('  the clicks reached the app as SGR mouse reports (the encoding it asked for)', out.includes('last="\\u001b[<'));

await page.locator('.xterm-helper-textarea').focus();
await page.keyboard.type('x');
await sleep(800);
check('typing in the browser claims the size', sizes.at(-1) === phoneSize, sizes.at(-1));

await browser.close();
watcher.close();
cli.write('q');
await sleep(300);
cli.kill();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
