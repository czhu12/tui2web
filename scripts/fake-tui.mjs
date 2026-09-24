// A minimal full-screen app for tests: alternate screen, mouse tracking on,
// and a status line counting the keys it has received. "q" quits.
const out = process.stdout;
let count = 0;
let last = '-';
const draw = () => out.write(`\x1b[H\x1b[2JFAKE-TUI count=${count} last=${last}\r\n(q to quit)`);
out.write('\x1b[?1049h\x1b[?1000;1006h');
draw();
process.stdin.setRawMode(true);
process.stdin.on('data', (d) => {
  const k = d.toString();
  if (k === 'q') {
    out.write('\x1b[?1000l\x1b[?1049l');
    process.exit(0);
  }
  count++;
  last = JSON.stringify(k);
  draw();
});
process.on('SIGWINCH', draw);
