// Tailscale mode: each session hosts its own relay on the tailnet address.
// Uses scripts/fake-tailscale.mjs, whose "tailnet" is loopback, so no real
// Tailscale is needed.
//   node scripts/tailscale.mjs
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { CLI_ENTRY, CLI_NODE } from './cli-cmd.mjs';
const require = createRequire(new URL('../packages/cli/package.json', import.meta.url));
const WebSocket = require('ws');
const { pty } = await import('../packages/cli/src/pty.ts');

const HOME = mkdtempSync(join(tmpdir(), 'tui2web-test-home-')); // keeps ~/.tui2web untouched
const env = { ...process.env, HOME, PS1: '$ ', TUI2WEB_TAILSCALE_BIN: resolve('scripts/fake-tailscale.mjs') };
delete env.TUI2WEB_RELAY;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  const t = Date.now();
  for (let v; !(v = fn()); await sleep(25)) if (Date.now() - t > ms) return null;
  return fn();
};

function start(args, extraEnv = {}) {
  const s = { out: '' };
  s.cli = pty.spawn(CLI_NODE, [CLI_ENTRY, '--no-qr', '--no-wait', ...args, 'bash', '--noprofile', '--norc'], {
    cols: 100, rows: 30, cwd: process.cwd(), env: { ...env, ...extraEnv },
  });
  s.cli.onData((d) => (s.out += d));
  s.exited = new Promise((r) => s.cli.onExit((e) => r(e.exitCode)));
  return s;
}
const LINK = /http:\/\/\S+\/session\/\S+\?token=[\w-]+/;
const printedLink = (s) => until(() => s.out.match(LINK)?.[0]);
/**
 * The link, from the link screen (hotkey) once connected: with --no-wait a
 * Tailscale session connects in the background, so it isn't known up front.
 */
async function linkOf(s) {
  await until(() => /\$ $/.test(s.out)); // bash is up, so the CLI is reading keys
  const mark = s.out.length;
  s.cli.write('\x1c');
  const link = await until(() => s.out.slice(mark).includes('● Connected') && s.out.slice(mark).match(LINK)?.[0]);
  s.cli.write('z'); // closes the link screen
  await sleep(200);
  return link;
}

/** Logs in with the link and returns what a viewer sees after typing `echo <word>`. */
async function roundTrip(link, word) {
  const u = new URL(link);
  const r = await fetch(link, { redirect: 'manual' });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  const ws = new WebSocket(`ws://${u.host}${u.pathname}/ws`, { headers: { cookie }, origin: u.origin });
  let screen = '';
  let snapshot = false;
  ws.on('message', (data, isBinary) => {
    if (isBinary) screen += data.toString();
    else if (JSON.parse(data.toString()).t === 'snapshot') snapshot = true;
  });
  let closed = null;
  ws.on('close', (code) => (closed = code));
  ws.on('unexpected-response', (_q, res) => (closed = `http ${res.statusCode}`));
  ws.on('error', () => {});
  if (!(await until(() => snapshot, 5000))) return { ok: false, why: `no snapshot (link ${r.status}, closed ${closed})` };
  ws.send(Buffer.from(`echo ${word}\r`));
  const ok = !!(await until(() => screen.includes(word) && screen.split(word).length > 2, 5000));
  ws.close();
  return { ok, why: ok ? '' : screen.slice(-200) };
}

// ---- 1. Two sessions, two relays ---------------------------------------------------
const a = start(['--tailscale']);
const b = start(['--tailscale']);
const [linkA, linkB] = [await linkOf(a), await linkOf(b)];
check('sessions print tailnet links', !!linkA && !!linkB, `${linkA?.replace(/token=.*/, '…')} ${linkB?.replace(/token=.*/, '…')}`);
const [ua, ub] = [new URL(linkA), new URL(linkB)];
check('links use the MagicDNS name', ua.hostname === 'localhost' && ub.hostname === 'localhost');
check('each session gets its own relay port', ua.port !== ub.port && Number(ua.port) >= 8787 && Number(ub.port) >= 8787, `${ua.port} vs ${ub.port}`);
check('link screen says the link is tailnet-only', a.out.includes('Private to your tailnet'));
check("  and that a phone can open it if it's on the tailnet", a.out.includes("your phone can open this link if it's on your tailnet"));
let rt = await roundTrip(linkA, 'hello-from-a');
check('phone can drive session A', rt.ok, rt.why);
rt = await roundTrip(linkB, 'hello-from-b');
check('phone can drive session B', rt.ok, rt.why);

// ---- 2. Killing one leaves the other running ---------------------------------------
a.cli.kill('SIGKILL');
await a.exited;
// Refused, or (if another relay shares the port on a wildcard address) not found.
const deadA = await fetch(linkA, { redirect: 'manual' }).then((r) => String(r.status), () => 'refused');
check("killed session's relay is gone", deadA === 'refused' || deadA === '404', deadA);
rt = await roundTrip(linkB, 'still-alive');
check('other session keeps working', rt.ok, rt.why);
b.cli.write('exit\r');
check('session B exits cleanly', (await Promise.race([b.exited, sleep(5000).then(() => 'timeout')])) === 0);

// ---- 3. Errors say what to do ------------------------------------------------------
// With a hotkey the session starts anyway (see 3b), so these use --hotkey none.
const cli = (args, extraEnv = {}) => spawnSync(CLI_NODE, [CLI_ENTRY, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15000 });
let res = cli(['--tailscale', '--hotkey', 'none', '--no-wait', 'true'], { FAKE_TAILSCALE_STATE: 'Stopped' });
check('stopped Tailscale is reported', res.status === 1 && res.stderr.includes('Tailscale is stopped'), res.stderr.trim());
res = cli(['--tailscale', '--hotkey', 'none', '--no-wait', 'true'], { FAKE_TAILSCALE_STATE: 'NeedsLogin' });
check('signed-out Tailscale is reported', res.status === 1 && res.stderr.includes('tailscale up'), res.stderr.trim());
res = cli(['--tailscale', '--hotkey', 'none', '--no-wait', 'true'], { TUI2WEB_TAILSCALE_BIN: '/nonexistent/tailscale' });
check('missing Tailscale is reported', res.status === 1 && res.stderr.includes('not installed'), res.stderr.trim());
res = cli(['--tailscale', '--hotkey', 'none', '--no-wait', 'true'], { FAKE_TAILSCALE_DOWN: '1' });
check('a daemon that isn\'t running is reported', res.status === 1 && res.stderr.includes("doesn't appear to be running"), res.stderr.trim());
res = cli(['--tailscale', '--hotkey', 'none', '--no-wait', 'true'], { FAKE_TAILSCALE_STATE: 'Stopped', FAKE_TAILSCALE_EXIT: '1' });
check('status JSON on a failing exit still names the state', res.status === 1 && res.stderr.includes('Tailscale is stopped'), res.stderr.trim());

// ---- 3a. Never falls back to another relay -------------------------------------------
// Every refusal says so and starts nothing: no link, and the command never runs.
const noSession = (r) => !/\/session\//.test(r.stdout) && !r.stdout.includes('RAN');
res = cli(['--tailscale', '--hotkey', 'none', '--no-wait', 'sh', '-c', 'echo RAN'], { FAKE_TAILSCALE_STATE: 'Stopped' });
check('refusal says it won\'t fall back', res.stderr.includes('never fall back to https://tui2web.com') && res.stderr.includes('run without --tailscale'), res.stderr.trim());
check('  and how to connect later instead', res.stderr.includes('drop --hotkey none'), res.stderr.trim());
check('  and starts nothing', noSession(res), res.stdout.slice(0, 120));
res = cli(['--tailscale', '--relay', 'https://tui2web.com', '--no-wait', 'true']);
check('--tailscale with --relay is refused', res.status === 2 && res.stderr.includes('Pick one'), res.stderr.trim());
res = cli(['--relay', 'https://tui2web.com', '--tailscale', '--no-wait', 'true']);
check('  in either order', res.status === 2 && res.stderr.includes('Pick one'), res.stderr.trim());

// ---- 3b. Off the tailnet: the command starts, and connects once Tailscale is up ------
const stateFile = join(HOME, 'fake-tailscale-state');
writeFileSync(stateFile, 'Stopped');
const g = start(['--tailscale'], { FAKE_TAILSCALE_STATE_FILE: stateFile });
await until(() => /\$ $/.test(g.out)); // bash is up
check('off the tailnet, the command starts straight away, printing nothing first', !g.out.includes('tui2web'), JSON.stringify(g.out.slice(0, 80)));
g.cli.write('\x1c');
await until(() => g.out.includes('to connect, or any other key'));
check('  and the link screen says why', g.out.includes('not on Tailscale yet') && g.out.includes("Couldn't connect") && g.out.includes('Tailscale is stopped'));
check('  with no link, and no public relay', !/\/session\//.test(g.out) && !g.out.includes('session is live'));
const lsOut = () => execFileSync(CLI_NODE, [CLI_ENTRY, 'ls'], { env }).toString();
check('  tui2web ls says it isn\'t on Tailscale yet', lsOut().includes('Not on Tailscale yet'));
let mark = g.out.length;
g.cli.write('c'); // still stopped
await until(() => g.out.slice(mark).includes('Checking Tailscale') && g.out.slice(mark).includes("Couldn't connect"));
check('c while Tailscale is still down checks again, and stays off', g.out.slice(mark).includes('Tailscale is stopped') && !/\/session\//.test(g.out));
writeFileSync(stateFile, 'Running');
mark = g.out.length;
g.cli.write('c');
const linkG = await until(() => g.out.slice(mark).match(/http:\/\/\S+\/session\/\S+\?token=[\w-]+/)?.[0]);
await until(() => g.out.slice(mark).includes('● Connected'));
check('c once Tailscale is up shows a tailnet link', !!linkG && new URL(linkG).hostname === 'localhost', linkG?.replace(/token=.*/, '…'));
rt = linkG ? await roundTrip(linkG, 'joined-later') : { ok: false, why: 'no link' };
check('  and a phone can drive it', rt.ok, rt.why);
check('  tui2web ls shows the link now', !!linkG && lsOut().includes(linkG));
g.cli.write('z');
await sleep(300);
g.cli.write('exit\r');
check('  and it exits cleanly', (await Promise.race([g.exited, sleep(5000).then(() => 'timeout')])) === 0);

// ---- 3c. --no-wait doesn't wait for Tailscale ----------------------------------------
const slow = start(['--tailscale'], { FAKE_TAILSCALE_DELAY: '4000' });
const t0 = Date.now();
await until(() => /\$ $/.test(slow.out));
check('--no-wait starts the command before Tailscale answers', Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
const linkSlow = await linkOf(slow);
check('  and connects in the background once it does', !!linkSlow, linkSlow?.replace(/token=.*/, '…'));
slow.cli.write('exit\r');
await slow.exited;

// ---- 4. MagicDNS off falls back to the IP ------------------------------------------
const c = start(['--tailscale'], { FAKE_TAILSCALE_MAGICDNS: '0' });
const linkC = await linkOf(c);
check('without MagicDNS the link uses the Tailscale IP', new URL(linkC).hostname === '127.0.0.1', linkC?.replace(/token=.*/, '…'));
c.cli.write('exit\r');
await c.exited;

// ---- 4a. A port someone else holds on all interfaces is skipped -------------------
// (e.g. `tui2web relay` on 8787: on macOS a loopback/tailnet bind could share it.)
const { createServer } = await import('node:net');
const blocker = createServer();
await new Promise((r) => blocker.once('error', r).listen({ port: 8787, host: '::' }, r)); // may already be held
const f = start(['--tailscale']);
const linkF = await linkOf(f);
check('skips a port held on all interfaces', !!linkF && new URL(linkF).port !== '8787', linkF?.replace(/token=.*/, '…'));
f.cli.write('exit\r');
await f.exited;
blocker.close();

// ---- 4b. Starting disconnected: the link is known up front and works after connecting
const e = start(['--tailscale', '--disconnected']);
const linkE = await printedLink(e);
check('--disconnected on the tailnet shows a MagicDNS link up front', !!linkE && new URL(linkE).hostname === 'localhost', linkE?.replace(/token=.*/, '…'));
check('  not live before connecting', (await fetch(linkE, { redirect: 'manual' })).status === 404);
await until(() => /\$ $/.test(e.out)); // bash is up, so the CLI is reading keys
e.cli.write('\x1c');
await until(() => e.out.includes('c\x1b[0m\x1b[2m to connect')); // the link screen's "Press c to connect"
e.cli.write('c');
await until(() => e.out.includes('● Connected'));
rt = await roundTrip(linkE, 'after-connect');
check('  same link works after c', rt.ok, rt.why);
e.cli.write('z');
await sleep(300);
e.cli.write('exit\r');
await e.exited;

// ---- 5. tui2web use ----------------------------------------------------------------
const config = () => JSON.parse(readFileSync(join(HOME, '.tui2web', 'config.json'), 'utf8'));
execFileSync(CLI_NODE, [CLI_ENTRY, 'use', 'tailscale'], { env });
check('use tailscale saves it', config().relay === 'tailscale');
const d = start([]);
const linkD = await linkOf(d);
check('plain tui2web then runs on the tailnet', !!linkD && new URL(linkD).hostname === 'localhost', linkD?.replace(/token=.*/, '…'));
d.cli.write('exit\r');
await d.exited;
check('use shows the current choice', execFileSync(CLI_NODE, [CLI_ENTRY, 'use'], { env }).toString().startsWith('tailscale'));
res = cli(['--hotkey', 'none', '--no-wait', 'sh', '-c', 'echo RAN'], { FAKE_TAILSCALE_STATE: 'NeedsLogin' });
check('default tailnet with Tailscale signed out (and no hotkey) is refused', res.status === 1 && res.stderr.includes('tui2web use public') && noSession(res), res.stderr.trim());
res = cli(['--no-wait', 'sh', '-c', 'echo RAN'], { TUI2WEB_RELAY: 'https://tui2web.com' });
check('$TUI2WEB_RELAY doesn\'t silently beat use tailscale', res.status === 2 && res.stderr.includes('$TUI2WEB_RELAY is set') && noSession(res), res.stderr.trim());
res = cli(['--no-wait', '--tailscale', '--hotkey', 'none', 'sh', '-c', 'echo RAN'], { TUI2WEB_RELAY: 'https://tui2web.com', FAKE_TAILSCALE_STATE: 'Stopped' });
check('  --tailscale still decides (and is refused while stopped)', res.status === 1 && res.stderr.includes('Tailscale is stopped'), res.stderr.trim());
execFileSync(CLI_NODE, [CLI_ENTRY, 'use', 'https://relay.example.com/'], { env });
check('use <url> saves the URL', config().relay === 'https://relay.example.com');
execFileSync(CLI_NODE, [CLI_ENTRY, 'use', 'public'], { env });
check('use public clears it', config().relay === undefined);
res = cli(['use', 'not a url']);
check('use rejects junk', res.status === 2);

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} FAILED` : `\nAll ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
