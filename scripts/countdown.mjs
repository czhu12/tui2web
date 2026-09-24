// Pre-start countdown: the command must not start until the timer runs out or
// Enter is pressed, and Ctrl+C must cancel without starting it.
//   node scripts/countdown.mjs [relay-url]
const { pty } = await import('../packages/cli/src/pty.ts');

const RELAY = process.argv[2] ?? 'http://localhost:8787';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The "command" writes a marker when it actually starts.
function run(waitArgs) {
  const s = { out: '', exit: null };
  s.cli = pty.spawn(process.execPath, ['packages/cli/src/index.ts', '--relay', RELAY, '--no-qr', ...waitArgs, 'bash', '-c', 'echo COMMAND-STARTED; sleep 30'], {
    cols: 100, rows: 30, cwd: process.cwd(), env: process.env,
  });
  s.cli.onData((d) => (s.out += d));
  s.exited = new Promise((r) => s.cli.onExit((e) => r((s.exit = e))));
  return s;
}
const started = (s) => s.out.includes('COMMAND-STARTED');

// 1. Waits, shows the countdown, then Enter starts it early.
let s = run(['--wait', '10']);
await sleep(2500);
check('link is printed before the command starts', /token=/.test(s.out));
check('countdown is shown', /Starting bash in \d+s/.test(s.out));
check('command has not started during the countdown', !started(s));
const t0 = Date.now();
s.cli.write('\r');
while (!started(s) && Date.now() - t0 < 5000) await sleep(25);
check('Enter starts the command immediately', started(s), `${Date.now() - t0}ms`);
s.cli.kill();

// 2. Starts on its own when the timer runs out.
s = run(['--wait', '2']);
await sleep(1200);
check('command waits for a short timer', !started(s));
const t1 = Date.now();
while (!started(s) && Date.now() - t1 < 5000) await sleep(25);
check('command starts when the timer runs out', started(s), `~${1200 + Date.now() - t1}ms after launch`);
s.cli.kill();

// 3. Ctrl+C cancels without ever starting the command.
s = run(['--wait', '10']);
await sleep(1500);
s.cli.write('\x03');
await Promise.race([s.exited, sleep(5000)]);
check('Ctrl+C cancels and exits with 130', s.exit?.exitCode === 130, JSON.stringify(s.exit));
check('command never started', !started(s));

// 4. --no-wait starts right away.
s = run(['--no-wait']);
const t2 = Date.now();
while (!started(s) && Date.now() - t2 < 5000) await sleep(25);
check('--no-wait starts immediately', started(s) && !/Starting bash in/.test(s.out), `${Date.now() - t2}ms`);
s.cli.kill();

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
