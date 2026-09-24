// End-to-end smoke test: runs the real CLI in a PTY against a running relay
// and plays the part of the phone (HTTP auth flow + viewer WebSocket).
//   node scripts/e2e.mjs [relay-url]
import { createRequire } from 'node:module';
import { CLI_ENTRY, CLI_NODE } from './cli-cmd.mjs';
const require = createRequire(new URL('../packages/cli/package.json', import.meta.url));
const { pty } = await import('../packages/cli/src/pty.ts');
const WebSocket = require('ws');

const RELAY = process.argv[2] ?? 'http://localhost:8787';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const until = (fn, ms = 5000) => new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => { const v = fn(); if (v) return resolve(v); if (Date.now() - start > ms) return reject(new Error('timeout')); setTimeout(tick, 25); };
  tick();
});

// 1. Start the CLI wrapping an interactive shell.
let cliOut = '';
const cli = pty.spawn(CLI_NODE, [CLI_ENTRY, '--relay', RELAY, '--no-qr', '--no-wait', 'bash', '--noprofile', '--norc'], {
  cols: 100, rows: 30, cwd: process.cwd(), env: { ...process.env, PS1: '$ ' },
});
cli.onData((d) => (cliOut += d));
const cliExited = new Promise((res) => cli.onExit(({ exitCode }) => res(exitCode)));
const url = await until(() => cliOut.match(/https?:\/\/\S+\/session\/\S+\?token=[\w-]+/)?.[0]).catch((err) => {
  console.log('CLI output so far:\n' + cliOut);
  throw err;
});
// Wait for bash's first prompt, so the snapshot has something in it.
await until(() => /\$ $/.test(cliOut));
check('CLI registers and prints a session URL', true, url.replace(/token=.*/, 'token=…'));
const u = new URL(url);
const base = `${u.origin}${u.pathname}`;
const id = u.pathname.split('/').pop();

// 2. Auth flow.
let r = await fetch(url, { redirect: 'manual' });
const setCookie = r.headers.get('set-cookie') ?? '';
check('token link redirects to clean URL', r.status === 303 && r.headers.get('location') === u.pathname, `${r.status} -> ${r.headers.get('location')}`);
check('token link sets HttpOnly session cookie', /HttpOnly/.test(setCookie) && setCookie.includes(`Path=/session/${id}`));
const cookie = setCookie.split(';')[0];

r = await fetch(base);
check('bare URL without cookie shows login page', r.status === 401 && (await r.text()).includes('Sign in'));
r = await fetch(base, { headers: { cookie } });
check('bare URL with cookie serves the viewer', r.status === 200 && (await r.text()).includes('id="term"'));
r = await fetch(`${base}?token=wrong`, { redirect: 'manual' });
check('wrong token is rejected', r.status === 401);
r = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ secret: 'nope' }), redirect: 'manual' });
check('wrong password redirects with error', r.status === 303 && r.headers.get('location').endsWith('?error'));
r = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ secret: u.searchParams.get('token') }), redirect: 'manual' });
check('login form accepts the token', r.status === 303 && /t2w_/.test(r.headers.get('set-cookie') ?? ''));
let locked = false;
for (let i = 0; i < 6; i++) {
  r = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ secret: 'bad' + i }), redirect: 'manual' });
  if (r.headers.get('location')?.endsWith('?locked')) locked = true;
}
check('login is rate limited', locked);

// 3. Viewer WebSocket.
const wsUrl = base.replace(/^http/, 'ws') + '/ws';
const noOrigin = await new Promise((res) => {
  const w = new WebSocket(wsUrl, { headers: { cookie } });
  w.on('unexpected-response', (_q, resp) => res(resp.statusCode));
  w.on('open', () => res('opened'));
  w.on('error', () => {});
});
check('viewer WS without same Origin is refused', noOrigin === 403, String(noOrigin));
const noCookie = await new Promise((res) => {
  const w = new WebSocket(wsUrl, { origin: u.origin });
  w.on('close', (code) => res(code));
  w.on('error', () => {});
});
check('viewer WS without cookie closes with 4401', noCookie === 4401, String(noCookie));

const msgs = [];
let screen = '';
const viewer = new WebSocket(wsUrl, { headers: { cookie }, origin: u.origin });
viewer.on('message', (data, isBinary) => {
  if (isBinary) screen += data.toString();
  else msgs.push(JSON.parse(data.toString()));
});
await until(() => msgs.find((m) => m.t === 'snapshot'));
const hello = msgs.find((m) => m.t === 'hello');
check('viewer gets hello with command and size', hello?.command === 'bash --noprofile --norc' && hello.cols === 100 && hello.agentConnected, JSON.stringify(hello));
check('snapshot contains the shell prompt', msgs.find((m) => m.t === 'snapshot').data.includes('$'));

// 4. Input from the "phone" runs in the shell, and output reaches both sides.
viewer.send(Buffer.from('echo hello-from-$((6*7))\r'));
await until(() => screen.includes('hello-from-42'));
check('phone input executes; output streams to viewer', true);
check('output is mirrored in the local terminal', cliOut.includes('hello-from-42'));

// 5. Resize negotiation: phone claims size, then local typing reclaims it.
viewer.send(JSON.stringify({ t: 'resize', cols: 50, rows: 20 }));
await until(() => msgs.find((m) => m.t === 'size' && m.cols === 50 && m.rows === 20));
viewer.send(Buffer.from('stty size\r'));
await until(() => screen.includes('20 50'));
check('phone resize reaches the PTY', true, 'stty size = 20 50');
cli.write('stty size\r');
await until(() => msgs.find((m) => m.t === 'size' && m.cols === 100 && m.rows === 30));
check('local typing takes the size back', true);

// 6. A second viewer sees the current screen straight away.
const late = [];
const v2 = new WebSocket(wsUrl, { headers: { cookie }, origin: u.origin });
v2.on('message', (d, bin) => { if (!bin) late.push(JSON.parse(d.toString())); });
await until(() => late.find((m) => m.t === 'snapshot'));
check('late viewer snapshot includes earlier output', late.find((m) => m.t === 'snapshot').data.includes('hello-from-42'));

// 7. Exit.
viewer.send(Buffer.from('exit 3\r'));
await until(() => msgs.find((m) => m.t === 'exit'));
check('viewer is told the exit code', msgs.find((m) => m.t === 'exit').code === 3);
const cliExit = await cliExited;
check('CLI exits with the command exit code', cliExit === 3, String(cliExit));
r = await fetch(base, { headers: { cookie } });
check('ended session page still loads (final screen viewable)', r.status === 200);

viewer.close(); v2.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
