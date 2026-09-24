import type { Terminal } from '@xterm/xterm';

// Keys a phone keyboard doesn't have. Arrows depend on the terminal's cursor
// mode (full-screen apps usually switch to "application" mode).
type Key = {
  label: string;
  aria?: string;
  seq?: string | ((term: Terminal) => string);
  sticky?: 'ctrl' | 'alt';
  repeat?: boolean;
  wide?: boolean;
};

const arrow = (c: string) => (term: Terminal) => (term.modes.applicationCursorKeysMode ? `\x1bO${c}` : `\x1b[${c}`);

const K = {
  esc: { label: 'Esc', seq: '\x1b' },
  tab: { label: 'Tab', seq: '\t' },
  shiftTab: { label: '⇧Tab', aria: 'Shift Tab', seq: '\x1b[Z' },
  ctrl: { label: 'Ctrl', sticky: 'ctrl' },
  alt: { label: 'Alt', sticky: 'alt' },
  up: { label: '↑', aria: 'Up', seq: arrow('A'), repeat: true },
  down: { label: '↓', aria: 'Down', seq: arrow('B'), repeat: true },
  right: { label: '→', aria: 'Right', seq: arrow('C'), repeat: true },
  left: { label: '←', aria: 'Left', seq: arrow('D'), repeat: true },
  ctrlC: { label: '^C', aria: 'Control C', seq: '\x03' },
  enter: { label: 'Enter', seq: '\r' },
} satisfies Record<string, Key>;

const ROW: Key[] = [
  K.esc, K.tab, K.ctrl, K.alt, K.up, K.down, K.left, K.right, K.shiftTab, K.ctrlC,
  { label: '|', seq: '|' },
  { label: '/', seq: '/' },
  { label: '~', seq: '~' },
  { label: '-', seq: '-' },
  { label: 'Home', seq: '\x1b[H' },
  { label: 'End', seq: '\x1b[F' },
  { label: 'PgUp', seq: '\x1b[5~', repeat: true },
  { label: 'PgDn', seq: '\x1b[6~', repeat: true },
  { label: '^D', aria: 'Control D', seq: '\x04' },
  { label: '^R', aria: 'Control R', seq: '\x12' },
];

// For answering prompts and moving through menus with the keyboard hidden.
const PAD: Key[] = [
  { label: '1', seq: '1' }, { label: '2', seq: '2' }, { label: '3', seq: '3' }, K.esc, K.ctrlC,
  { label: 'y', seq: 'y' }, K.up, { label: 'n', seq: 'n' }, K.tab, K.shiftTab,
  K.left, K.down, K.right, { ...K.enter, wide: true },
];

type Mods = { ctrl: boolean; alt: boolean };

export class Keys {
  private mods: Mods = { ctrl: false, alt: false };
  private stickyButtons: HTMLButtonElement[] = [];
  private term: Terminal;
  private send: (data: string) => void;

  constructor(opts: { term: Terminal; send: (data: string) => void; row: HTMLElement; pad: HTMLElement }) {
    this.term = opts.term;
    this.send = opts.send;
    this.render(opts.row, ROW);
    this.render(opts.pad, PAD);
  }

  /** Applies (and clears) the sticky Ctrl/Alt to typed input. */
  applyMods(data: string): string {
    if (!this.mods.ctrl && !this.mods.alt) return data;
    let out = data;
    if (this.mods.ctrl && data.length === 1) out = ctrlChar(data);
    if (this.mods.alt) out = '\x1b' + out;
    this.setMod('ctrl', false);
    this.setMod('alt', false);
    return out;
  }

  private render(container: HTMLElement, keys: Key[]) {
    for (const key of keys) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.tabIndex = -1;
      btn.textContent = key.label;
      if (key.aria) btn.setAttribute('aria-label', key.aria);
      if (key.wide) btn.classList.add('wide');
      if (key.sticky) {
        btn.dataset.sticky = key.sticky;
        this.stickyButtons.push(btn);
      }
      this.bind(btn, key);
      container.append(btn);
    }
  }

  private bind(btn: HTMLButtonElement, key: Key) {
    let repeatTimer: number | undefined;
    let armed = false;
    const stop = () => {
      window.clearTimeout(repeatTimer);
      window.clearInterval(repeatTimer);
      repeatTimer = undefined;
    };
    const fire = () => {
      if (key.sticky) return this.setMod(key.sticky, !this.mods[key.sticky]);
      const seq = typeof key.seq === 'function' ? key.seq(this.term) : key.seq;
      if (seq) this.send(seq);
    };

    // Cancelling pointerdown suppresses the compatibility mousedown, so the
    // terminal keeps focus and the on-screen keyboard stays open.
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (key.repeat) {
        fire();
        repeatTimer = window.setTimeout(() => {
          repeatTimer = window.setInterval(fire, 60);
        }, 400);
      } else {
        armed = true;
      }
    });
    // Non-repeating keys fire on release so a swipe across the row (which the
    // browser turns into a scroll and cancels) doesn't press anything.
    btn.addEventListener('pointerup', () => {
      stop();
      if (armed) fire();
      armed = false;
    });
    for (const type of ['pointercancel', 'pointerleave'] as const) {
      btn.addEventListener(type, () => {
        stop();
        armed = false;
      });
    }
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private setMod(mod: keyof Mods, on: boolean) {
    this.mods[mod] = on;
    for (const btn of this.stickyButtons) {
      if (btn.dataset.sticky === mod) btn.classList.toggle('active', on);
    }
  }
}

function ctrlChar(ch: string): string {
  if (ch === ' ') return '\x00';
  if (ch === '?') return '\x7f';
  const code = ch.toUpperCase().charCodeAt(0);
  return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code & 0x1f) : ch;
}
