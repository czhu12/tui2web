// Shell aliases and functions (e.g. alias claw="claude --dangerously-skip-permissions")
// only exist inside the user's shell; the CLI must run them through it.
//   node scripts/alias.mjs [relay-url]
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_ENTRY, CLI_NODE } from './cli-cmd.mjs';
const { pty } = await import('../packages/cli/src/pty.ts');

const RELAY = process.argv[2] ?? 'http://localhost:8787';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const RC = `
alias greet="echo HELLO-FROM-ALIAS"
alias failing="sh -c 'exit 7'"
shout() { echo "FN-$1-$2"; }
`;
const home = mkdtempSync(join(tmpdir(), 'tui2web-alias-home-'));
writeFileSync(join(home, '.bashrc'), RC);
writeFileSync(join(home, '.zshrc'), RC);

function run(shell, command) {
  return new Promise((resolve) => {
    let out = '';
    const cli = pty.spawn(CLI_NODE, [CLI_ENTRY, '--relay', RELAY, '--no-qr', '--no-wait', ...command], {
      cols: 100, rows: 30, cwd: process.cwd(),
      env: { ...process.env, HOME: home, ZDOTDIR: home, SHELL: shell },
    });
    cli.onData((d) => (out += d));
    cli.onExit(({ exitCode }) => resolve({ out, exitCode }));
    setTimeout(() => cli.kill(), 10000);
  });
}

for (const shell of ['/bin/bash', '/bin/zsh']) {
  if (!existsSync(shell)) {
    console.log(`skip  ${shell} (not installed)`);
    continue;
  }
  const name = shell.split('/').pop();
  let r = await run(shell, ['greet', 'two words', "it's quoted"]);
  check(`${name}: alias runs with its arguments intact`, r.out.includes("HELLO-FROM-ALIAS two words it's quoted"), r.out.match(/HELLO[^\r\n]*/)?.[0]);
  r = await run(shell, ['shout', 'a', 'b c']);
  check(`${name}: shell function runs`, r.out.includes('FN-a-b c'));
  r = await run(shell, ['failing']);
  check(`${name}: alias exit code passes through`, r.exitCode === 7, String(r.exitCode));
  r = await run(shell, ['definitely-not-a-command-xyz']);
  check(`${name}: unknown command fails with "not found"`, r.exitCode === 127 && /not found/i.test(r.out), String(r.exitCode));
}

// Real executables still launch directly, without a shell in between.
const r = await run('/bin/bash', ['sh', '-c', 'echo "parent=$(ps -o comm= -p $PPID)"']);
check('real commands are not wrapped in a shell', !/parent=.*bash/.test(r.out), r.out.match(/parent=\S*/)?.[0]);

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
