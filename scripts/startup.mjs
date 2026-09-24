// Startup screen, link hotkey and `tui2web ls`, using a fake full-screen app.
//   node scripts/startup.mjs [relay-url]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { Terminal } = require('@xterm/headless');
const WebSocket = require('ws');
const { pty } = await import('../packages/cli/src/pty.ts');

const RELAY = process.argv[2] ?? 'http://localhost:8787';
const HOME = mkdtempSync(join(tmpdir(), 'tui2web-test-home-')); // keeps ~/.tui2web untouched
const env = { ...process.env, HOME };
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) return false;
    await sleep(25);
  }
  return true;
};

// Runs the CLI and renders what the laptop's terminal shows.
function run(extra, command = ['node', 'scripts/fake-tui.mjs']) {
  const s = { raw: '', exit: null };
  s.screen = new Terminal({ cols: 90, rows: 40, allowProposedApi: true });
  s.cli = pty.spawn(process.execPath, ['packages/cli/src/index.ts', '--relay', RELAY, '--no-qr', ...extra, ...command], {
    cols: 90, rows: 40, cwd: process.cwd(), env,
  });
  s.cli.onData((d) => { s.raw += d; s.screen.write(d); });
  s.exited = new Promise((r) => s.cli.onExit((e) => r((s.exit = e))));
  s.text = () => new Promise((r) => s.screen.write('', () => {
    const b = s.screen.buffer.active;
    const lines = [];
    for (let i = 0; i < s.screen.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
    r(lines.join('\n'));
  }));
  return s;
}
const appLine = async (s) => (await s.text()).match(/FAKE-TUI count=\d+ last=\S+/)?.[0] ?? null;

// ---- 1. Startup screen waits for Enter, with no timer --------------------------
let s = run([]);
await until(() => /Press .*Enter.* to start/.test(s.raw));
check('link screen asks for Enter', /token=/.test(s.raw) && /Press .*Enter/.test(s.raw));
check('banner mentions the Ctrl+\\ hotkey', s.raw.includes('Press Ctrl+\\ any time to show this link again'));
await sleep(2500);
check('app has not started after 2.5s (no timer)', !s.raw.includes('FAKE-TUI'));
s.cli.write('x');
await sleep(300);
check('other keys do not start it', !s.raw.includes('FAKE-TUI'));
s.cli.write('\r');
check('Enter starts the app', await until(() => s.raw.includes('FAKE-TUI count=0')));

// ---- 2. tui2web ls from "another terminal" --------------------------------------
const url = s.raw.match(/http\S+token=[\w-]+/)[0];
const u = new URL(url);
const ls = execFileSync(process.execPath, ['packages/cli/src/index.ts', 'ls'], { env }).toString();
check('tui2web ls shows the running session link', ls.includes(url) && ls.includes('fake-tui.mjs'));

// ---- 3. Hotkey overlay ------------------------------------------------------------
s.cli.write('a');
await sleep(300);
const afterA = await appLine(s);
check('app receives normal keys', afterA === 'FAKE-TUI count=1 last="a"', afterA);

s.cli.write('\x1c'); // Ctrl+\
await sleep(400);
let screen = await s.text();
// The link wraps at 90 columns, so look for the session id rather than the whole URL.
check('Ctrl+\\ shows the link over the app', screen.includes(u.pathname.split('/').pop()) && screen.includes('Press any key to return') && !screen.includes('FAKE-TUI'));
check('app did not receive the hotkey', !s.raw.slice(-2000).includes('count=2'));

s.cli.write('\x1b[<0;10;5M'); // a mouse click report
await sleep(300);
check('mouse events do not close the overlay', (await s.text()).includes('Press any key to return'));

// The phone keeps working while the overlay is up.
const cookie = (await fetch(url, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
const phone = new WebSocket(`ws://${u.host}${u.pathname}/ws`, { headers: { cookie }, origin: u.origin });
await new Promise((r) => phone.on('open', r));
phone.send(Buffer.from('p'));
await sleep(500);
check('phone input still reaches the app during the overlay', true);
check('overlay stays up while the app updates in the background', (await s.text()).includes('Press any key to return'));

s.cli.write('z'); // any key closes; it must not reach the app
await sleep(600);
check('any key restores the app, including updates made meanwhile', (await appLine(s)) === 'FAKE-TUI count=2 last="p"', await appLine(s));
check('overlay is gone', !(await s.text()).includes('Press any key to return'));

s.cli.write('q');
await s.exited;
phone.close();
const lsAfter = execFileSync(process.execPath, ['packages/cli/src/index.ts', 'ls'], { env }).toString();
check('session disappears from tui2web ls after exit', lsAfter.includes('No tui2web sessions running'));

// ---- 4. Ctrl+C at the link screen cancels ------------------------------------------
s = run([]);
await until(() => /Press .*Enter/.test(s.raw));
s.cli.write('\x03');
await Promise.race([s.exited, sleep(5000)]);
check('Ctrl+C at the link screen cancels with 130', s.exit?.exitCode === 130 && !s.raw.includes('FAKE-TUI'), JSON.stringify(s.exit));

// ---- 5. --no-wait and --hotkey ------------------------------------------------------
s = run(['--no-wait', '--hotkey', 'ctrl-g']);
check('--no-wait starts the app immediately', await until(() => s.raw.includes('FAKE-TUI count=0')));
check('banner shows the custom hotkey', s.raw.includes('Press Ctrl+G any time'));
s.cli.write('\x1c');
await sleep(300);
check('with --hotkey ctrl-g, Ctrl+\\ goes to the app', (await appLine(s)) === 'FAKE-TUI count=1 last="\\u001c"', await appLine(s));
s.cli.write('\x07');
await sleep(300);
check('Ctrl+G shows the link', (await s.text()).includes('Press any key to return'));
s.cli.write(' ');
await sleep(300);
s.cli.write('q');
await Promise.race([s.exited, sleep(3000)]);

s = run(['--no-wait', '--hotkey', 'none']);
await until(() => s.raw.includes('FAKE-TUI count=0'));
check('--hotkey none: no hotkey line in banner', !s.raw.includes('any time to show this link'));
s.cli.write('q');
await Promise.race([s.exited, sleep(3000)]);

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
