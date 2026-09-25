#!/usr/bin/env node
import { StringDecoder } from 'node:string_decoder';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { hashPassword, loadConfig, promptHidden, saveConfig } from './config.ts';
import { RelayLink, type LinkState } from './link.ts';
import { DEFAULT_RELAY_PORT, startLocalRelay } from './local-relay.ts';
import { DEFAULT_HOTKEY, extractHotkey, isNotAKeyPress, parseHotkey, plainLetter, type Hotkey } from './hotkey.ts';
import { ScreenMirror } from './mirror.ts';
import { MouseModes } from './mouse.ts';
import { listSessions, registerSession } from './registry.ts';
import { resolveCommand } from './resolve.ts';
import { pty } from './pty.ts';
import { tailscaleAddress } from './tailscale.ts';

const require = createRequire(import.meta.url);
const qrcode: { generate(text: string, opts: { small: boolean }, cb: (qr: string) => void): void } = require('qrcode-terminal');
const { version } = require('../package.json');

const DEFAULT_RELAY = 'https://tui2web.com';
/** Relay setting that runs a private relay in each session, reachable over Tailscale. */
const TAILSCALE = 'tailscale';

const HELP = `tui2web ${version}: open a terminal program on your phone

Usage:
  tui2web [options] <command> [args...]
  tui2web ls                 Show links for your running sessions
  tui2web use <relay>        Choose the default relay: tailscale, public, or a URL
  tui2web autoconnect on|off Whether sessions connect to the relay as they start
  tui2web relay [options]    Run your own relay (see: tui2web relay --help)
  tui2web set-password       Set the password for opening sessions without the link
  tui2web clear-password     Remove the saved password

Options:
  --tailscale      Keep the session on your tailnet: this computer runs the relay
                   and only your Tailscale devices can reach it
  --relay <url>    Relay server (default: $TUI2WEB_RELAY, config, or ${DEFAULT_RELAY})
  --no-password    Only accept the link's token for this session, not your password
  --no-qr          Don't print a QR code
  --no-wait        Start the command right away instead of waiting for Enter
  --disconnected   Start without connecting to the relay; connect later from
                   the link screen (hotkey, then c). The link stays the same.
  --connected      Connect as the session starts (the default; overrides
                   tui2web autoconnect off)
  --hotkey <key>   Key that shows the link again while the command runs
                   (default: ctrl-\\; e.g. ctrl-^, ctrl-g, or none)
  -h, --help       Show this help
  -v, --version    Show version

Example:
  tui2web claude --continue
`;

type Options = { relay?: string; password: boolean; qr: boolean; wait: boolean; connect?: boolean; hotkey?: string; command: string[] };

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
    else if (arg === '--disconnected') opts.connect = false;
    else if (arg === '--connected') opts.connect = true;
    else if (arg === '--hotkey') opts.hotkey = argv[++i] ?? exit(2, '--hotkey needs a key, e.g. ctrl-\\');
    else if (arg.startsWith('--hotkey=')) opts.hotkey = arg.slice('--hotkey='.length);
    else if (arg === '--relay') opts.relay = argv[++i] ?? exit(2, '--relay needs a URL');
    else if (arg.startsWith('--relay=')) opts.relay = arg.slice('--relay='.length);
    else if (arg === '--tailscale') opts.relay = TAILSCALE;
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
  if (argv[0] === 'use') return useCommand(argv.slice(1));
  if (argv[0] === 'autoconnect') return autoconnectCommand(argv.slice(1));
  if (argv[0] === 'clear-password') {
    const { password: _, ...rest } = loadConfig();
    saveConfig(rest);
    return console.log('Password removed. Sessions will only accept the link token.');
  }

  const opts = parseArgs(argv);
  if (opts.command.length === 0) exit(2, HELP);

  const config = loadConfig();
  let relay = opts.relay ?? process.env.TUI2WEB_RELAY ?? config.relay ?? DEFAULT_RELAY;
  const onTailnet = relay === TAILSCALE;
  const password = opts.password ? (config.password ?? null) : null;
  const hotkeySpec = opts.hotkey ?? config.hotkey ?? DEFAULT_HOTKEY;
  const hotkey = parseHotkey(hotkeySpec);
  if (hotkey === undefined) exit(2, `Unknown hotkey "${hotkeySpec}". Use something like ctrl-\\, ctrl-^, ctrl-g, or none.`);
  const file = opts.command[0];
  const launch = resolveCommand(opts.command);
  const local = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  const startConnected = opts.connect ?? config.autoconnect ?? true;
  if (!startConnected && !hotkey) exit(2, 'Starting disconnected needs the hotkey, to connect later. Drop --hotkey none, or use --connected.');
  /** Where people open links, e.g. https://tui2web.com. */
  let publicBase = relay.replace(/\/+$/, '');

  // Tailscale: this process hosts its own relay, bound to the tailnet address
  // only, so it lives and dies with this session and nothing else can reach it.
  if (onTailnet) {
    try {
      const ts = await tailscaleAddress();
      const { port } = await startLocalRelay({
        port: DEFAULT_RELAY_PORT,
        scan: true,
        host: ts.ips,
        publicUrl: (port) => `http://${ts.host}:${port}`,
        // Logging would draw over the app.
        log: () => {},
      });
      relay = `http://${ts.ip}:${port}`;
      publicBase = `http://${ts.host}:${port}`;
    } catch (err) {
      exit(1, `tui2web: ${(err as Error).message}`);
    }
  }

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

  /** Redraws the link overlay if it's up, e.g. when the connection changes. */
  let refreshOverlay = () => {};
  const link = new RelayLink(relay, {
    onInput: (data) => term?.write(remoteDecoder.write(data)),
    onResize: (cols, rows) => {
      owner = 'remote';
      applySize(cols, rows);
    },
    snapshot: () => mirror.snapshot(),
    onState: () => refreshOverlay(),
  });

  const command = opts.command.join(' ');
  let session: { id: string; url: string };
  if (startConnected) {
    try {
      session = await link.register({ t: 'hello', command, ...size, password });
    } catch (err) {
      exit(1, `tui2web: ${(err as Error).message}`);
    }
  } else {
    // Nothing goes to the relay yet. Make the session's identity here, so the
    // link can be shown (and scanned) now; connecting creates it under these.
    const id = randomBytes(16).toString('base64url');
    const token = randomBytes(32).toString('base64url');
    link.prepare({ id, token, agentKey: randomBytes(32).toString('base64url'), command, password }, size);
    session = { id, url: `${publicBase}/session/${id}?token=${token}` };
  }

  const banner = () => bannerLines(session.url, opts.qr, password !== null, hotkey, onTailnet, link.state);
  process.stdout.write(banner().join('\n') + '\n');

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
    const state = link.state;
    const keys = state === 'disconnected' ? 'Press \x1b[1mc\x1b[0m\x1b[2m to connect' : 'Press \x1b[1md\x1b[0m\x1b[2m to disconnect';
    const lines = [...banner(), '', `\x1b[2m${keys}, or any other key to return to ${file}.\x1b[0m`].slice(0, Math.max(1, local().rows - 1));
    // Reset attributes and any scroll region so the overlay draws cleanly, and
    // turn off mouse reporting so the link can be selected and copied.
    stdout.write(mouse.disableSequence() + '\x1b[0m\x1b[r\x1b[H\x1b[2J' + lines.join('\r\n'));
  };
  refreshOverlay = () => {
    if (overlay === 'on') openOverlay();
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
      if (overlay !== 'on' || isNotAKeyPress(text)) return;
      const key = plainLetter(text);
      if (key === 'c') link.connect();
      else if (key === 'd') link.disconnect();
      else void closeOverlay();
      return;
    }
    const hot = extractHotkey(text, hotkey);
    if (hot.pressed) {
      text = hot.rest;
      openOverlay();
      if (!text) return;
    }
    // Only real key presses take the screen size back. Apps like Claude Code
    // turn on mouse and focus reporting, so moving the mouse over this
    // terminal or switching windows also sends input; letting that claim the
    // size makes it ping-pong with the phone (and the app redraws each time).
    if (owner !== 'local' && !isNotAKeyPress(text)) {
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

function bannerLines(url: string, qr: boolean, passwordEnabled: boolean, hotkey: Hotkey, tailnet: boolean, state: LinkState): string[] {
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const status =
    state === 'connected' ? '\x1b[32m● Connected\x1b[0m: your phone can open this link.'
    : state === 'connecting' ? '\x1b[33m◌ Connecting…\x1b[0m'
    : `\x1b[2m○ Disconnected\x1b[0m: nothing is on the relay. The link works again once you connect${hotkey ? ` (${hotkey.label}, then c)` : ''}.`;
  const title = state === 'disconnected' ? `${bold('tui2web')} session (disconnected):` : `${bold('tui2web')} session is live:`;
  const lines = ['', title, '', `  ${bold(url)}`, '', status, ''];
  if (qr) qrcode.generate(url, { small: true }, (code) => lines.push(...code.split('\n')));
  if (tailnet) lines.push(dim('Private to your tailnet: open it on a device signed into Tailscale.'));
  lines.push(dim(passwordEnabled ? 'Anyone with this link, or your tui2web password, can control this terminal.' : 'Anyone with this link can control this terminal.'));
  if (hotkey) lines.push(dim(`Press ${hotkey.label} any time to show this link again, and to connect or disconnect.`));
  lines.push('');
  return lines;
}

const RELAY_HELP = `tui2web relay: run your own relay server

Usage:
  tui2web relay [--port 8787] [--host <addr>] [--public-url <url>]
  tui2web relay --tailscale [--port 8787]

Options:
  --port <n>          Port to listen on (default: 8787)
  --host <addr>       Interface to bind (default: all, IPv6 and IPv4)
  --public-url <url>  URL people reach the relay at, used in session links.
                      Default: taken from each request, which works behind
                      reverse proxies.
  --tailscale         Listen on this computer's Tailscale address only, with
                      links using its MagicDNS name

Then point the CLI at it:
  tui2web --relay http://localhost:8787 claude

For a private relay per session, you don't need this command at all:
  tui2web --tailscale claude
Guide: https://github.com/czhu12/tui2web/blob/main/docs/self-hosting.md
`;

async function relayCommand(argv: string[]) {
  let port = DEFAULT_RELAY_PORT;
  let host: string | string[] | undefined;
  let publicUrl: string | undefined;
  let tailscale = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i] ?? exit(2, `${arg} needs a value`);
    if (arg === '-h' || arg === '--help') exit(0, RELAY_HELP);
    else if (arg === '--port') port = Number(value());
    else if (arg === '--host') host = value();
    else if (arg === '--public-url') publicUrl = value();
    else if (arg === '--tailscale') tailscale = true;
    else exit(2, `Unknown option ${arg}\n\n${RELAY_HELP}`);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) exit(2, '--port needs a port number');
  if (tailscale && (host || publicUrl)) exit(2, '--tailscale sets the host and public URL itself; drop --host and --public-url');

  let url = `http://localhost:${port}`;
  if (tailscale) {
    try {
      const ts = await tailscaleAddress();
      host = ts.ips;
      url = publicUrl = `http://${ts.host}:${port}`;
    } catch (err) {
      exit(1, `tui2web relay: ${(err as Error).message}`);
    }
  }

  let relay: Awaited<ReturnType<typeof startLocalRelay>>['relay'];
  try {
    ({ relay } = await startLocalRelay({ port, host, publicUrl: publicUrl === undefined ? undefined : () => publicUrl! }));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    exit(1, code === 'EADDRINUSE' ? `Port ${port} is already in use. Try another, e.g. --port ${port + 1}.` : `tui2web relay: ${(err as Error).message}`);
  }
  console.log(`\nUse it:  tui2web --relay ${url} claude`);
  if (tailscale) console.log('Only devices on your tailnet can reach it.\n');
  else console.log('Phone access from anywhere, privately: tui2web --tailscale claude\n');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      relay.close().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

const USE_HELP = `tui2web use: choose the default relay

Usage:
  tui2web use tailscale   Each session runs a private relay on this computer,
                          reachable only from your Tailscale devices
  tui2web use public      The public relay, ${DEFAULT_RELAY}
  tui2web use <url>       Your own relay, e.g. https://relay.example.com
  tui2web use             Show the current choice

--relay, --tailscale and $TUI2WEB_RELAY still override it for one session.
`;

async function useCommand(argv: string[]) {
  const choice = argv[0];
  const config = loadConfig();
  if (!choice) {
    const current = config.relay ?? DEFAULT_RELAY;
    console.log(current === TAILSCALE ? 'tailscale (a private relay per session, on your tailnet)' : current);
    if (process.env.TUI2WEB_RELAY) console.log(`(overridden by $TUI2WEB_RELAY=${process.env.TUI2WEB_RELAY})`);
    return;
  }
  if (choice === '-h' || choice === '--help') exit(0, USE_HELP);
  if (argv.length > 1) exit(2, USE_HELP);

  if (choice === 'public') {
    const { relay: _, ...rest } = config;
    saveConfig(rest);
    return console.log(`Sessions will use the public relay, ${DEFAULT_RELAY}.`);
  }
  if (choice === TAILSCALE) {
    try {
      const ts = await tailscaleAddress();
      saveConfig({ ...config, relay: TAILSCALE });
      console.log(`Sessions will run a private relay on this computer, with links like http://${ts.host}:${DEFAULT_RELAY_PORT}/…`);
      console.log('Open them on a phone signed into the same Tailscale account.');
    } catch (err) {
      exit(1, `tui2web: ${(err as Error).message}`);
    }
    return;
  }
  let url: URL;
  try {
    url = new URL(choice);
  } catch {
    exit(2, `"${choice}" is not a URL.\n\n${USE_HELP}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') exit(2, 'The relay URL must start with http:// or https://');
  saveConfig({ ...config, relay: choice.replace(/\/+$/, '') });
  console.log(`Sessions will use the relay at ${choice.replace(/\/+$/, '')}.`);
}

function autoconnectCommand(argv: string[]) {
  const config = loadConfig();
  const choice = argv[0];
  if (!choice) {
    return console.log(config.autoconnect === false ? 'off: sessions start disconnected' : 'on: sessions connect as they start');
  }
  if (argv.length > 1 || (choice !== 'on' && choice !== 'off')) exit(2, 'Usage: tui2web autoconnect on|off');
  if (choice === 'on') {
    const { autoconnect: _, ...rest } = config;
    saveConfig(rest);
    console.log('Sessions will connect to the relay as they start.');
  } else {
    saveConfig({ ...config, autoconnect: false });
    console.log('Sessions will start disconnected. Connect one from its link screen when you leave (the hotkey, then c).');
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
