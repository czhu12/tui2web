// Tailscale mode: each session hosts its own relay on the tailnet address.
// Uses scripts/fake-tailscale.mjs, whose "tailnet" is loopback, so no real
// Tailscale is needed.
//   node scripts/tailscale.mjs
import { mkdtempSync, readFileSync } from 'node:fs';
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
const linkOf = (s) => until(() => s.out.match(/http:\/\/\S+\/session\/\S+\?token=[\w-]+/)?.[0]);

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
  ws.on('error', () => {});
  if (!(await until(() => snapshot, 5000))) return { ok: false, why: 'no snapshot' };
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
check('banner says the link is tailnet-only', a.out.includes('Private to your tailnet'));
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
const cli = (args, extraEnv = {}) => spawnSync(CLI_NODE, [CLI_ENTRY, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15000 });
let res = cli(['--tailscale', '--no-wait', 'true'], { FAKE_TAILSCALE_STATE: 'Stopped' });
check('stopped Tailscale is reported', res.status === 1 && res.stderr.includes('Tailscale is stopped'), res.stderr.trim());
res = cli(['--tailscale', '--no-wait', 'true'], { FAKE_TAILSCALE_STATE: 'NeedsLogin' });
check('signed-out Tailscale is reported', res.status === 1 && res.stderr.includes('tailscale up'), res.stderr.trim());
res = cli(['--tailscale', '--no-wait', 'true'], { TUI2WEB_TAILSCALE_BIN: '/nonexistent/tailscale' });
check('missing Tailscale is reported', res.status === 1 && res.stderr.includes('not installed'), res.stderr.trim());

// ---- 4. MagicDNS off falls back to the IP ------------------------------------------
const c = start(['--tailscale'], { FAKE_TAILSCALE_MAGICDNS: '0' });
const linkC = await linkOf(c);
check('without MagicDNS the link uses the Tailscale IP', new URL(linkC).hostname === '127.0.0.1', linkC?.replace(/token=.*/, '…'));
c.cli.write('exit\r');
await c.exited;

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
execFileSync(CLI_NODE, [CLI_ENTRY, 'use', 'https://relay.example.com/'], { env });
check('use <url> saves the URL', config().relay === 'https://relay.example.com');
execFileSync(CLI_NODE, [CLI_ENTRY, 'use', 'public'], { env });
check('use public clears it', config().relay === undefined);
res = cli(['use', 'not a url']);
check('use rejects junk', res.status === 2);

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} FAILED` : `\nAll ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
