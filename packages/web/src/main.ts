import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { CLOSE_NOT_FOUND, CLOSE_UNAUTHORIZED, type RelayToViewer, type ViewerToRelay } from '@tui2web/protocol';
import { Keys } from './keys.ts';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const statusDot = $('#status');
const titleEl = $('#title');
const notice = $('#notice');
const wrap = $('#term-wrap');
const keyRow = $('#keys');
const pad = $('#pad');
const isTouch = matchMedia('(pointer: coarse)').matches;

// ---- terminal ---------------------------------------------------------------

const FONT_KEY = 'tui2web:fontSize';
const term = new Terminal({
  fontSize: loadFontSize(),
  fontFamily: 'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, monospace',
  scrollback: 5000,
  theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3', selectionBackground: '#264f78' },
  macOptionIsMeta: true,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open($('#term'));

const keys = new Keys({ term, send: sendInput, row: keyRow, pad });
term.onData((data) => sendInput(keys.applyMods(data)));
term.onBinary((data) => sendInput(data));

// ---- sizing -------------------------------------------------------------------
//
// The PTY has one size. Whoever typed last gets it (the laptop, or this
// screen). While the laptop owns it, the terminal renders at the laptop's size
// and #term-wrap scrolls.

let pty = { cols: 80, rows: 24 };
let ownSize = false;

function fitSize(): { cols: number; rows: number } | null {
  const d = fit.proposeDimensions();
  if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return null;
  return { cols: Math.max(20, d.cols), rows: Math.max(5, d.rows) };
}

/** Asks the laptop to resize the PTY to fit this screen. */
function claimSize() {
  const want = fitSize();
  if (!want) return;
  ownSize = true;
  if (want.cols !== pty.cols || want.rows !== pty.rows) sendControl({ t: 'resize', ...want });
}

function applyPtySize(cols: number, rows: number) {
  pty = { cols, rows };
  term.resize(cols, rows);
  const mine = fitSize();
  if (mine && (mine.cols !== cols || mine.rows !== rows)) ownSize = false;
}

// Follow the visual viewport so the key row sits right above the on-screen
// keyboard (iOS otherwise just scrolls the page underneath it).
function layout() {
  const vv = window.visualViewport;
  const root = document.documentElement.style;
  root.setProperty('--app-h', `${vv ? vv.height : window.innerHeight}px`);
  root.setProperty('--app-top', `${vv ? vv.offsetTop : 0}px`);
}

let resizeTimer: number | undefined;
function onViewportChange() {
  layout();
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (ownSize) claimSize();
  }, 150);
}
window.visualViewport?.addEventListener('resize', onViewportChange);
window.visualViewport?.addEventListener('scroll', layout);
window.addEventListener('resize', onViewportChange);
layout();

// ---- connection ---------------------------------------------------------------

const encoder = new TextEncoder();
let ws: WebSocket | null = null;
let ended = false;
let retries = 0;
let notFoundSince: number | null = null;
const RESTORE_WAIT_MS = 3 * 60_000;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}${location.pathname.replace(/\/+$/, '')}/ws`);
  socket.binaryType = 'arraybuffer';
  ws = socket;
  setStatus('connecting');

  socket.onopen = () => {
    retries = 0;
  };
  socket.onmessage = (e) => {
    if (typeof e.data !== 'string') {
      term.write(new Uint8Array(e.data as ArrayBuffer));
      return;
    }
    handle(JSON.parse(e.data) as RelayToViewer);
  };
  socket.onclose = (e) => {
    if (ws !== socket) return;
    ws = null;
    if (e.code === CLOSE_UNAUTHORIZED) {
      location.reload(); // the server shows the login page
      return;
    }
    if (e.code === CLOSE_NOT_FOUND) {
      // After a relay restart the session is gone until the laptop reconnects
      // and restores it, so keep trying for a while before giving up.
      notFoundSince ??= Date.now();
      if (Date.now() - notFoundSince > RESTORE_WAIT_MS) {
        ended = true;
        setStatus('ended');
        showNotice('This session has ended or no longer exists.', 'error');
        return;
      }
      setStatus('agent-away');
      showNotice('Relay restarted. Waiting for your computer to reconnect…');
    } else {
      if (ended) return;
      setStatus('offline');
      showNotice('Connection lost. Reconnecting…');
    }
    const delay = Math.min(10_000, 500 * 2 ** retries++);
    window.setTimeout(connect, delay);
  };
}

function handle(msg: RelayToViewer) {
  switch (msg.t) {
    case 'hello':
      notFoundSince = null;
      titleEl.textContent = msg.command;
      document.title = `${msg.command} · tui2web`;
      term.reset();
      applyPtySize(msg.cols, msg.rows);
      setAgent(msg.agentConnected);
      break;
    case 'snapshot':
      // Opening the page counts as "typing": take over the size once the
      // current screen is restored.
      term.write(msg.data, () => {
        if (!ended) claimSize();
      });
      break;
    case 'size':
      applyPtySize(msg.cols, msg.rows);
      break;
    case 'agent':
      setAgent(msg.connected);
      break;
    case 'exit':
      ended = true;
      setStatus('ended');
      showNotice(`Session ended (exit code ${msg.code}).`, 'error');
      break;
  }
}

function setAgent(connected: boolean) {
  if (ended) return;
  setStatus(connected ? 'live' : 'agent-away');
  if (connected) hideNotice();
  else showNotice('Your computer is offline. Waiting for it to reconnect…');
}

function sendInput(data: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN || ended) return;
  if (!ownSize) claimSize();
  ws.send(encoder.encode(data));
}

function sendControl(msg: ViewerToRelay) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---- chrome -------------------------------------------------------------------

function setStatus(state: 'connecting' | 'live' | 'agent-away' | 'offline' | 'ended') {
  statusDot.dataset.state = state;
}

function showNotice(text: string, kind: 'warn' | 'error' = 'warn') {
  notice.textContent = text;
  notice.dataset.kind = kind;
  notice.hidden = false;
  layout();
}

function hideNotice() {
  notice.hidden = true;
}

function loadFontSize(): number {
  try {
    const saved = Number(localStorage.getItem(FONT_KEY));
    if (saved >= 8 && saved <= 28) return saved;
  } catch {}
  return isTouch ? 12 : 14;
}

function setFontSize(size: number) {
  term.options.fontSize = Math.min(28, Math.max(8, size));
  try {
    localStorage.setItem(FONT_KEY, String(term.options.fontSize));
  } catch {}
  claimSize();
}

// Keys-only mode hides the phone keyboard (inputmode=none) and shows the pad,
// for answering prompts without the keyboard covering half the screen.
let padMode = false;
function setPadMode(on: boolean) {
  padMode = on;
  pad.hidden = !on;
  keyRow.hidden = on;
  const btn = $('[data-action="mode"]');
  btn.setAttribute('aria-pressed', String(on));
  btn.setAttribute('aria-label', on ? 'Switch to keyboard' : 'Switch to key pad');
  btn.textContent = on ? '⊞' : '⌨';
  if (on) {
    term.textarea?.setAttribute('inputmode', 'none');
    term.blur();
  } else {
    term.textarea?.removeAttribute('inputmode');
    term.focus();
  }
  onViewportChange();
}

document.addEventListener('click', (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
  if (action === 'font-down') setFontSize(term.options.fontSize! - 1);
  else if (action === 'font-up') setFontSize(term.options.fontSize! + 1);
  else if (action === 'mode') setPadMode(!padMode);
});

// Tapping the terminal while in pad mode shouldn't pop the keyboard back up.
wrap.addEventListener('pointerdown', () => {
  if (padMode) term.blur();
});

connect();
if (!isTouch) term.focus();
