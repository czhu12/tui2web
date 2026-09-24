// Relay restart test: a session survives the relay being killed and replaced
// (as in a deploy). Starts its own relay on port 8790.
//   node scripts/restart.mjs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const WebSocket = require('ws');
const { pty } = await import('../packages/cli/src/pty.ts');

const PORT = 8790;
const RELAY = `http://localhost:${PORT}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timeout');
    await sleep(50);
  }
};

function startRelay() {
  const p = spawn(process.execPath, ['packages/server/src/index.ts'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  let log = '';
  p.stdout.on('data', (d) => (log += d));
  return { p, log: () => log, ready: until(() => log.includes('listening')) };
}

let relay = startRelay();
await relay.ready;

let cliOut = '';
const cli = pty.spawn(process.execPath, ['packages/cli/src/index.ts', '--relay', RELAY, '--no-qr', 'bash', '--noprofile', '--norc'], {
  cols: 100, rows: 30, cwd: process.cwd(), env: { ...process.env, PS1: '$ ' },
});
cli.onData((d) => (cliOut += d));
let cliExitCode = null;
cli.onExit(({ exitCode }) => (cliExitCode = exitCode));

const url = await until(() => cliOut.match(/http\S+token=[\w-]+/)?.[0]);
const u = new URL(url);
const base = `${u.origin}${u.pathname}`;
const r = await fetch(url, { redirect: 'manual' });
const cookie = r.headers.get('set-cookie').split(';')[0];

function viewer() {
  const v = { msgs: [], screen: '', closeCode: null };
  v.ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { headers: { cookie }, origin: u.origin });
  v.ws.on('message', (d, bin) => (bin ? (v.screen += d.toString()) : v.msgs.push(JSON.parse(d.toString()))));
  v.ws.on('close', (code) => (v.closeCode = code));
  v.ws.on('error', () => {});
  return v;
}

let phone = viewer();
await until(() => phone.msgs.find((m) => m.t === 'snapshot'));
phone.ws.send(Buffer.from('echo before-restart-$((20+3))\r'));
await until(() => phone.screen.includes('before-restart-23'));
check('session works before restart', true);

// ---- kill the relay (as a deploy would) --------------------------------------
relay.p.kill('SIGTERM');
await new Promise((res) => relay.p.on('exit', res));
await until(() => phone.closeCode !== null);
check('phone is disconnected by the shutdown', phone.closeCode === 1001, String(phone.closeCode));

// Output produced while no relay exists must not be lost.
cli.write('echo during-outage-$((40+2))\r');
await until(() => cliOut.includes('during-outage-42'));
check('laptop keeps working while the relay is down', cliExitCode === null);

relay = startRelay();
await relay.ready;
await until(() => relay.log().includes('restored session'), 15000);
check('CLI re-registers the session on the new relay', true);

// The same link, the same cookie, the same session id.
let page = await fetch(base, { headers: { cookie } });
check('existing phone login cookie is still valid', page.status === 200, String(page.status));
page = await fetch(url, { redirect: 'manual' });
check('original printed link still works', page.status === 303);

phone = viewer();
const snap = await until(() => phone.msgs.find((m) => m.t === 'snapshot'));
check('restored screen includes output from before the restart', snap.data.includes('before-restart-23'));
check('restored screen includes output from during the outage', snap.data.includes('during-outage-42'));

phone.ws.send(Buffer.from('echo after-restart-$((60+1))\r'));
await until(() => phone.screen.includes('after-restart-61'));
check('phone input works after restore', true);
check('laptop still sees phone input', cliOut.includes('after-restart-61'));

// A resume with the wrong agent key must not take over the live session.
const hijack = await new Promise((res) => {
  const w = new WebSocket(RELAY.replace('http', 'ws') + '/agent');
  w.on('open', () => w.send(JSON.stringify({ t: 'resume', id: u.pathname.split('/').pop(), agentKey: 'x'.repeat(43), cols: 80, rows: 24, restore: { token: 'y'.repeat(43), command: 'evil', password: null } })));
  w.on('message', (d) => res(JSON.parse(d.toString())));
});
check('resume with wrong agent key is rejected', hijack.t === 'error', hijack.t);

phone.ws.send(Buffer.from('exit\r'));
await until(() => cliExitCode !== null);
check('session exits cleanly', cliExitCode === 0);

relay.p.kill('SIGTERM');
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
