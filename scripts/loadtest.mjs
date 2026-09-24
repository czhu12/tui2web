// Load test for the relay: N fake sessions (agent + one viewer each) against
// a running relay. Agents emit Claude-Code-like redraw traffic; viewers measure
// end-to-end latency via timestamped OSC markers.
//   node scripts/loadtest.mjs <relay-url> <relay-pid> <n1,n2,...> [busy|idle|full]
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const WebSocket = require('ws');

const [RELAY = 'http://localhost:8787', PID, STEPS = '50,200', MODE = 'busy'] = process.argv.slice(2);
const TICK_MS = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const agentUrl = RELAY.replace(/^http/, 'ws') + '/agent';

// ~400 bytes: move up, rewrite 5 status lines with colour, like a spinner/stream redraw.
const frame = (i) =>
  '\x1b[5A' +
  Array.from({ length: 5 }, (_, l) => `\x1b[2K\x1b[38;5;${(i + l) % 255}m✻ Thinking… line ${l} tick ${i} ${'·'.repeat(40)}\x1b[0m\r\n`).join('');

const latencies = [];
let viewerBytes = 0;
const sessions = [];

async function openSession() {
  const agent = new WebSocket(agentUrl);
  await new Promise((res, rej) => { agent.on('open', res); agent.on('error', rej); });
  agent.send(JSON.stringify({ t: 'hello', command: 'claude (load)', cols: 100, rows: 30, password: null }));
  const reg = await new Promise((res) => agent.once('message', (d) => res(JSON.parse(d.toString()))));
  const u = new URL(reg.url);
  const r = await fetch(u, { redirect: 'manual' });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const viewer = new WebSocket(`ws://${u.host}${u.pathname}/ws`, { headers: { cookie }, origin: u.origin });
  await new Promise((res, rej) => { viewer.on('open', res); viewer.on('error', rej); });
  viewer.on('message', (d, bin) => {
    if (!bin) return;
    viewerBytes += d.length;
    const s = d.toString();
    const m = s.match(/\x1b\]0;T(\d+)\x07/);
    if (m) latencies.push(Date.now() - Number(m[1]));
  });
  if (MODE === 'full') {
    // Fill the relay's 1000-line scrollback, like a long Claude session would.
    const line = (n) => `\x1b[36m${String(n).padStart(5)}\x1b[0m ${'lorem ipsum dolor sit amet '.repeat(3)}\r\n`;
    agent.send(Buffer.from(Array.from({ length: 1100 }, (_, n) => line(n)).join('')));
  }
  const s = { agent, viewer, i: 0 };
  sessions.push(s);
  return s;
}

// Memory comes from the relay itself (heap + typed-array buffers): macOS
// compresses idle pages, which makes RSS from `ps` undercount.
async function stats() {
  const cpu = Number(execSync(`ps -o %cpu= -p ${PID}`).toString().trim());
  const h = await (await fetch(`${RELAY}/healthz`)).text();
  const num = (k) => Number(h.match(new RegExp(`${k}=(\\d+)`))[1]);
  return { rssMB: num('heapMB') + num('buffersMB'), cpu, sessions: num('sessions') };
}
const pct = (arr, p) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : NaN);

let timer = null;
function startTraffic() {
  if (MODE !== 'busy') return;
  // Stagger sessions across the tick so traffic isn't one big burst.
  timer = setInterval(() => {
    const now = Date.now();
    for (const s of sessions) {
      if (s.agent.readyState !== 1) continue;
      s.i++;
      // One latency probe per session per second.
      const probe = s.i % 10 === 0 ? `\x1b]0;T${now}\x07` : '';
      s.agent.send(Buffer.from(frame(s.i) + probe));
    }
  }, TICK_MS);
}

console.log(`mode=${MODE}  (busy = ~4 KB/s of redraw output per session, 1 viewer each)`);
global.gc?.(); const base = await stats();
console.log(`baseline: heap+buffers=${base.rssMB}MB`);
console.log('sessions | heap+buf  | MB/session | relay CPU | throughput to viewers | latency p50 / p99 / max');
startTraffic();
for (const n of STEPS.split(',').map(Number)) {
  while (sessions.length < n) {
    await Promise.all(Array.from({ length: Math.min(50, n - sessions.length) }, openSession));
  }
  await sleep(3000); // settle
  latencies.length = 0;
  viewerBytes = 0;
  const cpuSamples = [];
  for (let k = 0; k < 5; k++) { await sleep(1000); cpuSamples.push((await stats()).cpu); }
  const st = await stats();
  if (st.sessions !== n) console.log(`  !! relay reports ${st.sessions} sessions, expected ${n}`);
  const cpu = Math.round(cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length);
  const mbps = (viewerBytes / 5 / 1024 / 1024).toFixed(1);
  const lat = MODE === 'busy' ? `${pct(latencies, 0.5)} / ${pct(latencies, 0.99)} / ${Math.max(...latencies)} ms` : 'n/a';
  console.log(`${String(n).padStart(8)} | ${String(st.rssMB).padStart(6)} MB | ${((st.rssMB - base.rssMB) / n).toFixed(2).padStart(10)} | ${String(cpu).padStart(7)} % | ${mbps.padStart(13)} MB/s      | ${lat}`);
}
clearInterval(timer);
for (const s of sessions) { s.agent.terminate(); s.viewer.terminate(); }
process.exit(0);
