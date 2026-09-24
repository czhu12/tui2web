#!/usr/bin/env node
import { StringDecoder } from 'node:string_decoder';
import { createRequire } from 'node:module';
import { hashPassword, loadConfig, promptHidden, saveConfig } from './config.ts';
import { RelayLink } from './link.ts';
import { pty } from './pty.ts';

const require = createRequire(import.meta.url);
const qrcode: { generate(text: string, opts: { small: boolean }, cb: (qr: string) => void): void } = require('qrcode-terminal');
const { version } = require('../package.json');

// TODO: switch to https://tui2web.com once the domain is set up.
const DEFAULT_RELAY = 'https://tui2web.oncanine.run';

const HELP = `tui2web ${version}: open a terminal program on your phone

Usage:
  tui2web [options] <command> [args...]
  tui2web set-password       Set the password for opening sessions without the link
  tui2web clear-password     Remove the saved password

Options:
  --relay <url>    Relay server (default: $TUI2WEB_RELAY, config, or ${DEFAULT_RELAY})
  --no-password    Only accept the link's token for this session, not your password
  --no-qr          Don't print a QR code
  -h, --help       Show this help
  -v, --version    Show version

Example:
  tui2web claude --continue
`;

type Options = { relay?: string; password: boolean; qr: boolean; command: string[] };

function parseArgs(argv: string[]): Options {
  const opts: Options = { password: true, qr: true, command: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      i++;
      break;
    }
    if (!arg.startsWith('-')) break;
    if (arg === '-h' || arg === '--help') exit(0, HELP);
    else if (arg === '-v' || arg === '--version') exit(0, version);
    else if (arg === '--no-password') opts.password = false;
    else if (arg === '--no-qr') opts.qr = false;
    else if (arg === '--relay') opts.relay = argv[++i] ?? exit(2, '--relay needs a URL');
    else if (arg.startsWith('--relay=')) opts.relay = arg.slice('--relay='.length);
    else exit(2, `Unknown option ${arg}\n\n${HELP}`);
  }
  opts.command = argv.slice(i);
  return opts;
}

function exit(code: number, message: string): never {
  (code === 0 ? process.stdout : process.stderr).write(message.endsWith('\n') ? message : message + '\n');
  process.exit(code);
}

async function setPassword() {
  const first = await promptHidden('New password: ');
  if (first.length < 8) exit(1, 'Password must be at least 8 characters.');
  const second = await promptHidden('Confirm password: ');
  if (first !== second) exit(1, 'Passwords did not match.');
  saveConfig({ ...loadConfig(), password: hashPassword(first) });
  console.log('Password saved. Sessions you start from now on will accept it.');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'set-password') return setPassword();
  if (argv[0] === 'clear-password') {
    const { password: _, ...rest } = loadConfig();
    saveConfig(rest);
    return console.log('Password removed. Sessions will only accept the link token.');
  }

  const opts = parseArgs(argv);
  if (opts.command.length === 0) exit(2, HELP);

  const config = loadConfig();
  const relay = opts.relay ?? process.env.TUI2WEB_RELAY ?? config.relay ?? DEFAULT_RELAY;
  const password = opts.password ? (config.password ?? null) : null;
  const [file, ...args] = opts.command;
  const local = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });

  let term: ReturnType<typeof pty.spawn> | null = null;
  let size = local();
  // Whoever typed last decides the PTY size, like tmux's `window-size latest`.
  let owner: 'local' | 'remote' = 'local';
  const remoteDecoder = new StringDecoder('utf8');

  const applySize = (cols: number, rows: number) => {
    if (cols === size.cols && rows === size.rows) return;
    size = { cols, rows };
    term?.resize(cols, rows);
    link.sendSize(cols, rows);
  };

  const link = new RelayLink(relay, {
    onInput: (data) => term?.write(remoteDecoder.write(data)),
    onResize: (cols, rows) => {
      owner = 'remote';
      applySize(cols, rows);
    },
  });

  let session: { id: string; url: string };
  try {
    session = await link.register({ t: 'hello', command: opts.command.join(' '), ...size, password });
  } catch (err) {
    exit(1, `tui2web: ${(err as Error).message}`);
  }

  printBanner(session.url, opts.qr, password !== null);

  try {
    term = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: process.cwd(),
      env: { ...process.env, TUI2WEB_SESSION: session.id } as Record<string, string>,
    });
  } catch (err) {
    await link.finish(127);
    exit(127, `tui2web: could not start ${file}: ${(err as Error).message}`);
  }

  term.onData((data) => {
    process.stdout.write(data);
    link.sendOutput(Buffer.from(data, 'utf8'));
  });

  const { stdin } = process;
  if (stdin.isTTY) stdin.setRawMode(true);
  const localDecoder = new StringDecoder('utf8');
  stdin.on('data', (chunk: Buffer) => {
    if (owner !== 'local') {
      owner = 'local';
      applySize(local().cols, local().rows);
    }
    term?.write(localDecoder.write(chunk));
  });
  stdin.resume();

  process.stdout.on('resize', () => {
    if (owner === 'local') applySize(local().cols, local().rows);
  });

  for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => term?.kill(signal));
  }

  term.onExit(async ({ exitCode }) => {
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    await link.finish(exitCode);
    const note = link.lostReason ? ` (relay lost the session: ${link.lostReason})` : '';
    process.stderr.write(`\r\n[tui2web] session ${session.id} ended${note}\r\n`);
    process.exit(exitCode);
  });
}

function printBanner(url: string, qr: boolean, passwordEnabled: boolean) {
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const lines = ['', `${bold('tui2web')} session is live:`, '', `  ${bold(url)}`, ''];
  if (qr) qrcode.generate(url, { small: true }, (code) => lines.push(code));
  lines.push(dim(passwordEnabled ? 'Anyone with this link, or your tui2web password, can control this terminal.' : 'Anyone with this link can control this terminal.'), '');
  process.stdout.write(lines.join('\n') + '\n');
}

main().catch((err) => exit(1, `tui2web: ${err?.stack ?? err}`));
