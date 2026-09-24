// Runs `tui2web claude` in a PTY (the "laptop") with a WebSocket viewer (the
// "phone"), renders both streams with headless xterm, and prints both screens
// at each step, to check the two stay in sync. Never presses Enter in Claude.
//   node scripts/claude-sync.mjs
import { createRequire } from 'node:module';
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { Terminal } = require('@xterm/headless');
const WebSocket = require('ws');
const { pty } = await import('../packages/cli/src/pty.ts');

const LAPTOP = { cols: 120, rows: 35 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const screen = (t, label) => {
  const b = t.buffer.active;
  const lines = [];
  for (let i = 0; i < t.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  console.log(`\n┌─ ${label} (${t.cols}x${t.rows}) ${'─'.repeat(Math.max(0, 60 - label.length))}`);
  for (const l of lines) console.log('│' + l);
  console.log('└' + '─'.repeat(70));
};

// Laptop: the real terminal the user sees.
const laptop = new Terminal({ ...LAPTOP, allowProposedApi: true });
let raw = '';
const cli = pty.spawn(process.execPath, ['packages/cli/src/index.ts', '--no-qr', 'claude'], {
  ...LAPTOP, name: 'xterm-256color', cwd: process.cwd(), env: process.env,
});
cli.onData((d) => { raw += d; laptop.write(d); });
const exited = new Promise((r) => cli.onExit(({ exitCode }) => r(exitCode)));

while (!/token=/.test(raw)) await sleep(50);
const u = new URL(raw.match(/http\S+token=[\w-]+/)[0]);
const r = await fetch(u, { redirect: 'manual' });
const cookie = r.headers.get('set-cookie').split(';')[0];

// Phone: the viewer, rendered at whatever size the PTY currently is.
const phone = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
const ws = new WebSocket(`ws://${u.host}${u.pathname}/ws`, { headers: { cookie }, origin: u.origin });
ws.on('message', (d, bin) => {
  if (bin) return phone.write(d);
  const m = JSON.parse(d.toString());
  if (m.t === 'hello' || m.t === 'size') phone.resize(m.cols, m.rows);
  if (m.t === 'snapshot') phone.write(m.data);
  if (m.t === 'exit') console.log('\n[phone] exit', m.code);
});
const type = (s) => ws.send(Buffer.from(s));

const step = async (title, fn, wait = 1500) => {
  console.log(`\n\n=== ${title} ===`);
  await fn?.();
  await sleep(wait);
  screen(laptop, 'LAPTOP');
  screen(phone, 'PHONE');
};

await step('1. Claude Code started (laptop owns size)', null, 7000);
await step('2. phone types into the prompt', () => type('hello from the phone'));
await step('3. laptop types more into the same prompt', () => cli.write(' + laptop'));
await step('4. phone claims a phone-sized screen (46x28) and types', () => {
  ws.send(JSON.stringify({ t: 'resize', cols: 46, rows: 28 }));
  type(' !');
}, 2500);
await step('5. laptop types again: laptop takes size back', () => cli.write('?'), 2500);

// Clear the prompt and quit without ever submitting it.
type('\x03'); await sleep(400); type('\x03'); await sleep(400); type('\x03');
const code = await Promise.race([exited, sleep(8000).then(() => 'timeout')]);
console.log('\nCLI exit:', code);
if (code === 'timeout') cli.kill();
ws.close();
process.exit(0);
