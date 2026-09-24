#!/usr/bin/env node
import { StringDecoder } from 'node:string_decoder';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { hashPassword, loadConfig, promptHidden, saveConfig } from './config.ts';
import { RelayLink } from './link.ts';
import { DEFAULT_HOTKEY, extractHotkey, isNotAKeyPress, parseHotkey, type Hotkey } from './hotkey.ts';
import { ScreenMirror } from './mirror.ts';
import { MouseModes } from './mouse.ts';
import { listSessions, registerSession } from './registry.ts';
import { resolveCommand } from './resolve.ts';
import { pty } from './pty.ts';

const require = createRequire(import.meta.url);
const qrcode: { generate(text: string, opts: { small: boolean }, cb: (qr: string) => void): void } = require('qrcode-terminal');
const { version } = require('../package.json');

const DEFAULT_RELAY = 'https://tui2web.com';

const HELP = `tui2web ${version}: open a terminal program on your phone

Usage:
  tui2web [options] <command> [args...]
  tui2web ls                 Show links for your running sessions
  tui2web relay [options]    Run your own relay (see: tui2web relay --help)
  tui2web set-password       Set the password for opening sessions without the link
  tui2web clear-password     Remove the saved password

Options:
  --relay <url>    Relay server (default: $TUI2WEB_RELAY, config, or ${DEFAULT_RELAY})
  --no-password    Only accept the link's token for this session, not your password
  --no-qr          Don't print a QR code
  --no-wait        Start the command right away instead of waiting for Enter
  --hotkey <key>   Key that shows the link again while the command runs
                   (default: ctrl-\\; e.g. ctrl-^, ctrl-g, or none)
  -h, --help       Show this help
  -v, --version    Show version

Example:
  tui2web claude --continue
`;

type Options = { relay?: string; password: boolean; qr: boolean; wait: boolean; hotkey?: string; command: string[] };

function parseArgs(argv: string[]): Options {
  const opts: Options = { password: true, qr: true, wait: true, command: [] };
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
    else if (arg === '--no-wait') opts.wait = false;
    else if (arg === '--hotkey') opts.hotkey = argv[++i] ?? exit(2, '--hotkey needs a key, e.g. ctrl-\\');
    else if (arg.startsWith('--hotkey=')) opts.hotkey = arg.slice('--hotkey='.length);
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
  if (argv[0] === 'ls') return listCommand();
  if (argv[0] === 'relay') return relayCommand(argv.slice(1));
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
  const hotkeySpec = opts.hotkey ?? config.hotkey ?? DEFAULT_HOTKEY;
  const hotkey = parseHotkey(hotkeySpec);
  if (hotkey === undefined) exit(2, `Unknown hotkey "${hotkeySpec}". Use something like ctrl-\\, ctrl-^, ctrl-g, or none.`);
  const file = opts.command[0];
  const launch = resolveCommand(opts.command);
  const local = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });

  let term: ReturnType<typeof pty.spawn> | null = null;
  let size = local();
  // Whoever typed last decides the PTY size, like tmux's `window-size latest`.
  let owner: 'local' | 'remote' = 'local';
  const remoteDecoder = new StringDecoder('utf8');
  const mirror = new ScreenMirror(size.cols, size.rows);

  const applySize = (cols: number, rows: number) => {
    if (cols === size.cols && rows === size.rows) return;
    size = { cols, rows };
    term?.resize(cols, rows);
    mirror.resize(cols, rows);
    link.sendSize(cols, rows);
  };

  const link = new RelayLink(relay, {
    onInput: (data) => term?.write(remoteDecoder.write(data)),
    onResize: (cols, rows) => {
      owner = 'remote';
      applySize(cols, rows);
    },
    snapshot: () => mirror.snapshot(),
  });

  let session: { id: string; url: string };
  try {
    session = await link.register({ t: 'hello', command: opts.command.join(' '), ...size, password });
  } catch (err) {
    exit(1, `tui2web: ${(err as Error).message}`);
  }

  const banner = bannerLines(session.url, opts.qr, password !== null, hotkey);
  process.stdout.write(banner.join('\n') + '\n');

  // Full-screen programs clear the screen as soon as they start, which would
  // hide the link and QR code, so wait until the user has grabbed it.
  if (opts.wait && process.stdin.isTTY && !(await waitForEnter(file))) {
    await link.finish(130);
    exit(130, 'Cancelled.');
  }

  try {
    term = pty.spawn(launch.file, launch.args, {
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

  registerSession({ url: session.url, command: opts.command.join(' '), cwd: process.cwd() });

  // While the link overlay is up, the app keeps running (and the phone keeps
  // working) but its output isn't drawn locally. On close, the local screen is
  // repainted from the mirror, which has kept up the whole time.
  let overlay: 'off' | 'on' | 'restoring' = 'off';
  let heldOutput: string[] = [];
  const mouse = new MouseModes();
  const { stdin, stdout } = process;

  const openOverlay = () => {
    overlay = 'on';
    const lines = [...banner, '', `\x1b[2mPress any key to return to ${file}.\x1b[0m`].slice(0, Math.max(1, local().rows - 1));
    // Reset attributes and any scroll region so the overlay draws cleanly, and
    // turn off mouse reporting so the link can be selected and copied.
    stdout.write(mouse.disableSequence() + '\x1b[0m\x1b[r\x1b[H\x1b[2J' + lines.join('\r\n'));
  };

  const closeOverlay = async () => {
    overlay = 'restoring';
    let screen = await mirror.screen();
    // The serialized screen replays the normal buffer, then switches to the
    // alternate one. The terminal is already there, so keep only the latter.
    const alt = screen.lastIndexOf('\x1b[?1049h');
    if (alt >= 0) screen = screen.slice(alt + '\x1b[?1049h'.length);
    stdout.write('\x1b[0m\x1b[H\x1b[2J' + screen + mouse.restoreSequence() + heldOutput.join(''));
    heldOutput = [];
    overlay = 'off';
    // Most TUIs redraw fully on SIGWINCH, which also restores anything the
    // mirror can't express (like scroll regions).
    if (process.platform !== 'win32') term?.kill('SIGWINCH');
  };

  term.onData((data) => {
    mouse.observe(data);
    if (overlay === 'off') stdout.write(data);
    else if (overlay === 'restoring') heldOutput.push(data);
    mirror.write(data);
    link.sendOutput(Buffer.from(data, 'utf8'));
  });

  if (stdin.isTTY) stdin.setRawMode(true);
  const localDecoder = new StringDecoder('utf8');
  stdin.on('data', (chunk: Buffer) => {
    let text = localDecoder.write(chunk);
    if (overlay !== 'off') {
      // Mouse reports, focus changes and key releases don't close it.
      if (overlay === 'on' && !isNotAKeyPress(text)) void closeOverlay();
      return;
    }
    const hot = extractHotkey(text, hotkey);
    if (hot.pressed) {
      text = hot.rest;
      openOverlay();
      if (!text) return;
    }
    if (owner !== 'local') {
      owner = 'local';
      applySize(local().cols, local().rows);
    }
    term?.write(text);
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
    process.stderr.write(`\r\n[tui2web] session ended${note}: ${session.url}\r\n`);
    process.exit(exitCode);
  });
}

/**
 * Holds the link screen until the user is ready. Resolves true on Enter (start
 * the command), false on Ctrl+C / Esc (cancel).
 */
function waitForEnter(command: string): Promise<boolean> {
  const { stdin, stdout } = process;
  stdout.write(`Press \x1b[1mEnter\x1b[0m to start ${command} \x1b[2m(Ctrl+C to cancel)\x1b[0m`);
  return new Promise((resolve) => {
    const onKey = (key: Buffer) => {
      const k = key.toString();
      const start = k === '\r' || k === '\n';
      if (!start && k !== '\u0003' && k !== '\u001b') return;
      stdin.off('data', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\r\x1b[2K');
      resolve(start);
    };
    stdin.setRawMode(true);
    stdin.on('data', onKey);
    stdin.resume();
  });
}

function bannerLines(url: string, qr: boolean, passwordEnabled: boolean, hotkey: Hotkey): string[] {
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const lines = ['', `${bold('tui2web')} session is live:`, '', `  ${bold(url)}`, ''];
  if (qr) qrcode.generate(url, { small: true }, (code) => lines.push(...code.split('\n')));
  lines.push(dim(passwordEnabled ? 'Anyone with this link, or your tui2web password, can control this terminal.' : 'Anyone with this link can control this terminal.'));
  if (hotkey) lines.push(dim(`Press ${hotkey.label} any time to show this link again.`));
  lines.push('');
  return lines;
}

const RELAY_HELP = `tui2web relay: run your own relay server

Usage:
  tui2web relay [--port 8787] [--host <addr>] [--public-url <url>]

Options:
  --port <n>          Port to listen on (default: 8787)
  --host <addr>       Interface to bind (default: all, IPv6 and IPv4)
  --public-url <url>  URL people reach the relay at, used in session links.
                      Default: taken from each request, which works behind
                      proxies and tunnels like Cloudflare Tunnel.

Then point the CLI at it:
  tui2web --relay http://localhost:8787 claude

To use it from your phone away from home, put it behind a tunnel, e.g.:
  cloudflared tunnel --url http://localhost:8787
Guide: https://github.com/czhu12/tui2web/blob/main/docs/self-hosting.md
`;

type StartRelay = (opts: { port: number; host?: string; publicUrl?: string; webDist: string }) => {
  listening: Promise<void>;
  close(): Promise<void>;
};

async function relayCommand(argv: string[]) {
  let port = 8787;
  let host: string | undefined;
  let publicUrl: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i] ?? exit(2, `${arg} needs a value`);
    if (arg === '-h' || arg === '--help') exit(0, RELAY_HELP);
    else if (arg === '--port') port = Number(value());
    else if (arg === '--host') host = value();
    else if (arg === '--public-url') publicUrl = value();
    else exit(2, `Unknown option ${arg}\n\n${RELAY_HELP}`);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) exit(2, '--port needs a port number');

  // Published package: the relay is compiled into dist/relay with the web
  // viewer in dist/web. Running from the repo: use the sources directly.
  const compiled = new URL('./relay/relay.js', import.meta.url);
  const fromDist = existsSync(fileURLToPath(compiled));
  const source = '../../server/src/relay.ts';
  const { startRelay }: { startRelay: StartRelay } = await import(fromDist ? compiled.href : source);
  const webDist = fileURLToPath(new URL(fromDist ? './web/' : '../../web/dist/', import.meta.url));

  const relay = startRelay({ port, host, publicUrl, webDist });
  try {
    await relay.listening;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    exit(1, code === 'EADDRINUSE' ? `Port ${port} is already in use. Try another, e.g. --port ${port + 1}.` : `tui2web relay: ${(err as Error).message}`);
  }
  const local = `http://localhost:${port}`;
  console.log(`\nUse it:  tui2web --relay ${local} claude`);
  console.log(`Phone access from anywhere: cloudflared tunnel --url ${local}  (then use the tunnel URL as --relay)\n`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      relay.close().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

function listCommand() {
  const sessions = listSessions();
  if (sessions.length === 0) return console.log('No tui2web sessions running.');
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  for (const s of sessions) {
    const started = new Date(s.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    console.log(`${bold(s.command)}  ${dim(`${s.cwd} · started ${started} · pid ${s.pid}`)}\n  ${s.url}\n`);
  }
  // With a single session, show its QR code too, since that's usually why you're here.
  if (sessions.length === 1) qrcode.generate(sessions[0].url, { small: true }, (code) => console.log(code));
}

main().catch((err) => exit(1, `tui2web: ${err?.stack ?? err}`));
