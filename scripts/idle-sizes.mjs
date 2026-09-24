// Reproduces "constant flashing while idle": a laptop terminal and a phone
// that both answer the app's terminal queries (like real terminals do), with
// nobody typing. Counts how often the PTY size changes.
//   node scripts/idle-sizes.mjs [relay-url] [command...]
import { createRequire } from 'node:module';
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { Terminal } = require('@xterm/headless');
const WebSocket = require('ws');
const { pty } = await import('../packages/cli/src/pty.ts');

const RELAY = process.argv[2] ?? 'http://localhost:8787';
const command = process.argv.slice(3).length ? process.argv.slice(3) : ['claude'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LAPTOP = { cols: 110, rows: 24 };
const PHONE = { cols: 43, rows: 46 };

// Laptop: a terminal emulator that answers queries (cursor position, device
// attributes, ...) by writing to the CLI's stdin, as VS Code's terminal does.
const laptop = new Terminal({ ...LAPTOP, allowProposedApi: true });
let out = '';
const cli = pty.spawn(process.execPath, ['packages/cli/src/index.ts', '--relay', RELAY, '--no-qr', '--no-wait', ...command], { ...LAPTOP, cwd: process.cwd(), env: process.env });
cli.onData((d) => { out += d; laptop.write(d); });
laptop.onData((d) => cli.write(d));
while (!/token=[\w-]+/.test(out)) await sleep(50);
const url = out.match(/http\S+token=[\w-]+/)[0];

// Phone: same idea, with the web viewer's rule for claiming the size.
const u = new URL(url);
const cookie = (await fetch(url, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
const ws = new WebSocket(`${u.origin.replace(/^http/, 'ws')}${u.pathname}/ws`, { headers: { cookie }, origin: u.origin });
const phone = new Terminal({ ...PHONE, allowProposedApi: true });
let ptySize = null;
const sizes = [];
const responses = { laptop: 0, phone: 0 };
laptop.onData(() => responses.laptop++);
const isKeyPress = (d) => !/^(?:\x1b\[<[\d;]*[Mm]|\x1b\[M[\s\S]{3}|\x1b\[[IO])+$/.test(d);
const isResponse = (d) => /^(?:\x1b\[\??\d+;\d+R|\x1b\[\d*n|\x1b\[[?>=][\d;]*c|\x1b\[\?\d+u|\x1b\[\?[\d;]*\$y|\x1b\[\d+(?:;\d+)*t|\x1bP[^\x1b]*\x1b\\|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/.test(d);
phone.onData((d) => {
  if (process.env.OLD_VIEWER !== '1' && isResponse(d)) return; // like the viewer: don't answer queries
  responses.phone++;
  if (isKeyPress(d) && ptySize !== `${PHONE.cols}x${PHONE.rows}`) ws.send(JSON.stringify({ t: 'resize', ...PHONE }));
  ws.send(Buffer.from(d));
});
ws.on('message', (d, bin) => {
  if (bin) return phone.write(d);
  const m = JSON.parse(d.toString());
  if (m.t === 'hello' || m.t === 'size') { ptySize = `${m.cols}x${m.rows}`; phone.resize(m.cols, m.rows); if (m.t === 'size') sizes.push(`${(Date.now() / 1000 % 100).toFixed(1)}s ${ptySize}`); }
  if (m.t === 'snapshot') phone.write(m.data);
});
await new Promise((r) => ws.on('open', r));

await sleep(6000); // let the app start
const before = sizes.length;
responses.laptop = responses.phone = 0;
await sleep(10000); // nobody touches anything
console.log(`size changes in 10s idle: ${sizes.length - before}`);
console.log(`terminal responses sent in 10s: laptop=${responses.laptop} phone=${responses.phone}`);
console.log('last few:', sizes.slice(-6).join(' | '));
for (const k of ['\x03', '\x03', '\x03']) { cli.write(k); await sleep(400); }
await sleep(1000); cli.kill(); ws.close(); process.exit(0);
