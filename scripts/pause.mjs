// Connecting and disconnecting from the link screen (hotkey, then c / d), and
// starting disconnected. Starts its own relay on port 8793.
//   node scripts/pause.mjs
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { CLI_ENTRY, CLI_NODE } from './cli-cmd.mjs';
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { Terminal } = require('@xterm/headless');
const WebSocket = require('ws');
const { pty } = await import('../packages/cli/src/pty.ts');

const PORT = 8793;
const RELAY = `http://localhost:${PORT}`;
const HOME = mkdtempSync(join(tmpdir(), 'tui2web-test-home-')); // keeps ~/.tui2web untouched
const env = { ...process.env, HOME };
delete env.TUI2WEB_RELAY;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) return null;
    await sleep(50);
  }
};

const relay = spawn(process.execPath, ['packages/server/src/index.ts'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
let relayLog = '';
relay.stdout.on('data', (d) => (relayLog += d));
await until(() => relayLog.includes('listening'));
const sessionsOnRelay = async () => Number((await (await fetch(`${RELAY}/healthz`)).text()).match(/sessions=(\d+)/)[1]);

// Runs the CLI around the fake full-screen app and renders the laptop's terminal.
function run(extra) {
  const s = { raw: '' };
  s.screen = new Terminal({ cols: 110, rows: 40, allowProposedApi: true });
  s.cli = pty.spawn(CLI_NODE, [CLI_ENTRY, '--relay', RELAY, '--no-qr', ...extra, 'node', 'scripts/fake-tui.mjs'], { cols: 110, rows: 40, cwd: process.cwd(), env });
  s.cli.onData((d) => { s.raw += d; s.screen.write(d); });
  s.exited = new Promise((r) => s.cli.onExit((e) => r(e.exitCode)));
  s.text = () => new Promise((r) => s.screen.write('', () => {
    const b = s.screen.buffer.active;
    const lines = [];
    for (let i = 0; i < s.screen.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
    r(lines.join('\n'));
  }));
  s.shows = (text, ms = 5000) => until(async () => (await s.text()).includes(text), ms);
  return s;
}
const linkOf = (s) => until(() => s.raw.match(/http\S+token=[\w-]+/)?.[0]);

/** A phone: logs in with the cookie and records what the viewer socket sees. */
function phone(link, cookie) {
  const u = new URL(link);
  const p = { screen: '', snapshot: null, closed: null };
  p.ws = new WebSocket(`ws://${u.host}${u.pathname}/ws`, { headers: { cookie }, origin: u.origin });
  p.ws.on('message', (d, bin) => {
    if (bin) p.screen += d.toString();
    else if (JSON.parse(d.toString()).t === 'snapshot') p.snapshot = JSON.parse(d.toString()).data;
  });
  p.ws.on('close', (code) => (p.closed = code));
  p.ws.on('error', () => {});
  return p;
}

// ---- 1. Connected by default; d disconnects -----------------------------------------
let s = run([]);
await until(() => /Press .*Enter/.test(s.raw));
const link = await linkOf(s);
const u = new URL(link);
const base = `${u.origin}${u.pathname}`;
check('starts connected by default', s.raw.includes('session is live') && s.raw.includes('Connected'));
s.cli.write('\r');
await s.shows('FAKE-TUI count=0');
const cookie = (await fetch(link, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
let ph = phone(link, cookie);
check('phone sees the app', !!(await until(() => ph.snapshot?.includes('FAKE-TUI'))));

s.cli.write('\x1c');
check('link screen shows Connected and how to disconnect', !!(await s.shows('Press d to disconnect')) && (await s.text()).includes('● Connected'));
s.cli.write('d');
check('d disconnects', !!(await s.shows('○ Disconnected')));
check('link screen now offers c to connect', (await s.text()).includes('Press c to connect'));
check('phone is told the computer disconnected (4410)', (await until(() => ph.closed)) === 4410, String(ph.closed));
check('relay no longer has the session', (await sessionsOnRelay()) === 0);
let r = await fetch(base, { headers: { cookie } });
let body = await r.text();
check('reloading on the phone shows a self-refreshing Disconnected page', r.status === 503 && body.includes('Disconnected') && body.includes('http-equiv="refresh"'), String(r.status));
ph = phone(link, cookie);
check('a new phone connection is told it is disconnected', (await until(() => ph.closed)) === 4410, String(ph.closed));

// The app keeps running while disconnected.
s.cli.write('z'); // closes the overlay; not passed to the app
await sleep(400);
s.cli.write('a');
await s.shows('count=1 last="a"');

// ---- 2. c reconnects, same link and token -------------------------------------------
s.cli.write('\x1c');
await s.shows('Press c to connect');
s.cli.write('c');
check('c connects again', !!(await s.shows('● Connected')));
check('relay has the session again', (await until(async () => (await sessionsOnRelay()) === 1)) === true);
r = await fetch(base, { headers: { cookie } });
check('same URL, and the phone is still logged in', r.status === 200 && (await r.text()).includes('id="term"'), String(r.status));
r = await fetch(link, { redirect: 'manual' });
check('the original token link still works', r.status === 303);
ph = phone(link, cookie);
check('phone gets the current screen, including output from while disconnected', !!(await until(() => ph.snapshot?.includes('count=1 last="a"'))));
ph.ws.send(Buffer.from('p'));
check('phone input reaches the app again', !!(await until(() => ph.screen.includes('last="p"'))));

// kitty keyboard protocol encodes plain letters too (Claude Code turns it on).
s.cli.write('\x1b[100u'); // "d"
check('d works as a kitty keyboard sequence', !!(await s.shows('○ Disconnected')));
s.cli.write('\x1b[99u'); // "c"
check('c works as a kitty keyboard sequence', !!(await s.shows('● Connected')));
s.cli.write('z');
await sleep(300);
s.cli.write('q');
check('exits cleanly', (await s.exited) === 0);
ph.ws.close();

// ---- 3. Starting disconnected ------------------------------------------------------
// Ended sessions stay viewable on the relay for a while, so count from here.
let before = await sessionsOnRelay();
s = run(['--disconnected']);
await until(() => /Press .*Enter/.test(s.raw));
const link2 = await linkOf(s);
check('--disconnected shows the link up front', !!link2 && s.raw.includes('(disconnected)'));
check('nothing was sent to the relay', (await sessionsOnRelay()) === before);
r = await fetch(link2, { redirect: 'manual' });
check('the link is not live yet', r.status === 404, String(r.status));
s.cli.write('\r');
await s.shows('FAKE-TUI count=0');
check('still nothing on the relay after the app starts', (await sessionsOnRelay()) === before);
s.cli.write('\x1c');
await s.shows('Press c to connect');
s.cli.write('c');
await s.shows('● Connected');
r = await fetch(link2, { redirect: 'manual' });
check('after c, the same link works', r.status === 303, String(r.status));
s.cli.write('z');
await sleep(300);
s.cli.write('q');
await s.exited;

// ---- 4. The default can be changed ----------------------------------------------------
const cli = (args) => spawnSync(CLI_NODE, [CLI_ENTRY, ...args], { env, encoding: 'utf8', timeout: 15000 });
const config = () => JSON.parse(readFileSync(join(HOME, '.tui2web', 'config.json'), 'utf8'));
cli(['autoconnect', 'off']);
check('autoconnect off saves it', config().autoconnect === false);
check('autoconnect shows the setting', cli(['autoconnect']).stdout.startsWith('off'));
before = await sessionsOnRelay();
s = run(['--no-wait']);
await linkOf(s);
check('sessions then start disconnected', !!(await until(() => s.raw.includes('(disconnected)'))) && (await sessionsOnRelay()) === before);
s.cli.write('q');
await s.exited;
s = run(['--no-wait', '--connected']);
await linkOf(s);
check('--connected overrides it', !!(await until(async () => (await sessionsOnRelay()) === before + 1)));
s.cli.write('q');
await s.exited;
cli(['autoconnect', 'on']);
check('autoconnect on clears it', config().autoconnect === undefined);
const bad = cli(['--disconnected', '--hotkey', 'none', 'true']);
check('--disconnected without a hotkey is refused', bad.status === 2 && bad.stderr.includes('needs the hotkey'), bad.stderr.trim());

// ---- 5. Relay unreachable at start (offline): starts disconnected, c tries again -------
const OFFLINE = 'http://localhost:8794'; // nothing listens here until the relay "comes back"
s = run(['--relay', OFFLINE]);
await until(() => /Press .*Enter/.test(s.raw));
const link5 = await linkOf(s);
check('unreachable relay: starts anyway, disconnected, with the link', !!link5 && s.raw.includes('(disconnected)') && link5.startsWith(OFFLINE));
check('  and says why', s.raw.includes("Couldn't connect") && s.raw.includes('could not reach relay'), s.raw.match(/Couldn't connect.*/)?.[0]);
s.cli.write('\r');
await s.shows('FAKE-TUI count=0');
s.cli.write('\x1c');
await s.shows('Press c to connect');
let mark = s.raw.length;
s.cli.write('c'); // still unreachable
await until(() => s.raw.slice(mark).includes("Couldn't connect"));
check('c while still offline tries once and stays disconnected', (await s.text()).includes('○ Disconnected') && (await s.text()).includes('Press c to connect'));
const relay5 = spawn(process.execPath, ['packages/server/src/index.ts'], { env: { ...process.env, PORT: '8794' }, stdio: ['ignore', 'pipe', 'inherit'] });
let relay5Log = '';
relay5.stdout.on('data', (d) => (relay5Log += d));
await until(() => relay5Log.includes('listening'));
s.cli.write('c');
check('c once the relay is reachable connects', !!(await s.shows('● Connected')));
check('  and the error is gone', !(await s.text()).includes("Couldn't connect"));
r = await fetch(link5, { redirect: 'manual' });
check('  the link shown at start works', r.status === 303, String(r.status));
ph = phone(link5, r.headers.get('set-cookie').split(';')[0]);
check('  phone sees the app', !!(await until(() => ph.snapshot?.includes('FAKE-TUI'))));
ph.ws.close();
s.cli.write('z');
await sleep(300);
s.cli.write('q');
check('  exits cleanly', (await s.exited) === 0);
relay5.kill();
const offlineNoHotkey = cli(['--relay', OFFLINE, '--hotkey', 'none', '--no-wait', 'sh', '-c', 'echo RAN']);
check('unreachable relay without a hotkey is refused', offlineNoHotkey.status === 1 && offlineNoHotkey.stderr.includes('could not reach relay') && offlineNoHotkey.stderr.includes('drop --hotkey none') && !offlineNoHotkey.stdout.includes('RAN'), offlineNoHotkey.stderr.trim());

// ---- 6. --no-wait doesn't wait for the relay ------------------------------------------
// A relay that accepts the connection and never answers: the worst case, a hang.
const { createServer } = await import('node:net');
const held = [];
const hung = createServer((sock) => held.push(sock));
await new Promise((r) => hung.listen(8795, r));
const t0 = Date.now();
s = run(['--relay', 'http://localhost:8795', '--no-wait']);
await s.shows('FAKE-TUI count=0');
check('--no-wait starts the app before the relay answers', Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
check('  its link is printed up front', !!(await linkOf(s)));
s.cli.write('\x1c');
check('  link screen shows it connecting meanwhile', !!(await s.shows('◌ Connecting')));
check('  and gives up after the timeout, saying why', !!(await s.shows("Couldn't connect", 15000)) && (await s.text()).includes('timed out'));
s.cli.write('z');
await sleep(300);
s.cli.write('q');
await s.exited;
for (const sock of held) sock.destroy();
hung.close();

relay.kill();
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} FAILED` : `\n${results.length}/${results.length} passed`);
process.exit(failed ? 1 : 0);
