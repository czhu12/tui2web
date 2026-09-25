/**
 * A key that shows the session link again while a full-screen app is running.
 * `byte` is the classic control byte; `codes` are the key's codepoints, which is
 * how terminals report it once an app (Claude Code, for one) enables the kitty
 * keyboard protocol or xterm's modifyOtherKeys.
 */
export type Hotkey = { label: string; byte: string; codes: number[] } | null;

export const DEFAULT_HOTKEY = 'ctrl-\\';

// Punctuation Ctrl combinations: the control byte, and the codepoints a
// terminal may report instead (e.g. Ctrl+^ is Ctrl+Shift+6 on US layouts).
const CTRL_PUNCTUATION: Record<string, { byte: string; codes: number[]; shown: string }> = {
  '\\': { byte: '\x1c', codes: [92], shown: '\\' },
  backslash: { byte: '\x1c', codes: [92], shown: '\\' },
  ']': { byte: '\x1d', codes: [93], shown: ']' },
  '^': { byte: '\x1e', codes: [94, 54], shown: '^' },
  '6': { byte: '\x1e', codes: [54, 94], shown: '6' },
  _: { byte: '\x1f', codes: [95, 45], shown: '_' },
  '/': { byte: '\x1f', codes: [47], shown: '/' },
  '@': { byte: '\x00', codes: [64, 50, 32], shown: '@' },
  space: { byte: '\x00', codes: [32], shown: 'Space' },
};

/**
 * Parses specs like "ctrl-\", "ctrl-^", "ctrl-g" or "none". Returns undefined
 * if the spec isn't understood.
 */
export function parseHotkey(spec: string): Hotkey | undefined {
  const s = spec.trim().toLowerCase();
  if (s === 'none' || s === 'off') return null;
  const m = /^(?:ctrl|control|c)[-+](.+)$/.exec(s);
  if (!m) return undefined;
  const key = m[1];
  if (/^[a-z]$/.test(key)) {
    const code = key.charCodeAt(0);
    return { label: `Ctrl+${key.toUpperCase()}`, byte: String.fromCharCode(code - 96), codes: [code] };
  }
  const p = CTRL_PUNCTUATION[key];
  return p ? { label: `Ctrl+${p.shown}`, byte: p.byte, codes: p.codes } : undefined;
}

// kitty keyboard protocol: CSI code[:alternates] ; modifiers[:event] u
const KITTY_KEY = /\x1b\[(\d+)(?::\d*)*;(\d+)(?::(\d+))?u/g;
// xterm modifyOtherKeys: CSI 27 ; modifiers ; code ~
const MODIFY_OTHER_KEYS = /\x1b\[27;(\d+);(\d+)~/g;

/** Ctrl (optionally with Shift), ignoring Caps Lock / Num Lock. */
function isCtrl(modifiers: number): boolean {
  const bits = (modifiers - 1) & ~(64 | 128);
  return bits === 4 || bits === 5;
}

/**
 * Finds the hotkey in a chunk of terminal input, in any of its encodings.
 * Returns whether it was pressed, and the input with it removed.
 */
export function extractHotkey(input: string, hotkey: Hotkey): { pressed: boolean; rest: string } {
  if (!hotkey) return { pressed: false, rest: input };
  let pressed = false;
  let rest = input.split(hotkey.byte).join('');
  if (rest !== input) pressed = true;
  rest = rest.replace(KITTY_KEY, (seq, code, mods, event) => {
    if (!hotkey.codes.includes(Number(code)) || !isCtrl(Number(mods))) return seq;
    if (event !== '3') pressed = true; // swallow the release event too
    return '';
  });
  rest = rest.replace(MODIFY_OTHER_KEYS, (seq, mods, code) => {
    if (!hotkey.codes.includes(Number(code)) || !isCtrl(Number(mods))) return seq;
    pressed = true;
    return '';
  });
  return { pressed, rest };
}

// Mouse reports (SGR and X10), focus in/out, kitty key-release events, and
// the terminal's own answers to queries the app sends: cursor position, device
// status and attributes, kitty keyboard flags, mode reports, window reports,
// and DCS/OSC replies (e.g. XTVERSION, colours). Claude Code asks these on
// every redraw, so treating the answers as typing made the size ping-pong.
const NOT_A_KEY = new RegExp(
  '^(?:' +
    [
      '\\x1b\\[<[\\d;]*[Mm]',
      '\\x1b\\[M[\\s\\S]{3}',
      '\\x1b\\[[IO]',
      '\\x1b\\[[\\d:;]*:3u',
      '\\x1b\\[\\??\\d+;\\d+R',
      '\\x1b\\[\\d*n',
      '\\x1b\\[[?>=][\\d;]*c',
      '\\x1b\\[\\?\\d+u',
      '\\x1b\\[\\?[\\d;]*\\$y',
      '\\x1b\\[\\d+(?:;\\d+)*t',
      '\\x1bP[^\\x1b]*\\x1b\\\\',
      '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)',
    ].join('|') +
    ')+$',
);

/** True for input that isn't the user typing: mouse, focus, key releases, query answers. */
export function isNotAKeyPress(input: string): boolean {
  return NOT_A_KEY.test(input);
}

// kitty keyboard protocol, a key with no modifiers: CSI code[:alternates] [; 1[:event]] u
const KITTY_PLAIN = /^\x1b\[(\d+)(?::\d*)*(?:;(\d+)(?::(\d+))?)?u$/;

/**
 * The letter typed, lowercased, if the input is one unmodified letter key, in
 * any encoding (apps like Claude Code turn on the kitty keyboard protocol).
 */
export function plainLetter(input: string): string | null {
  if (/^[a-zA-Z]$/.test(input)) return input.toLowerCase();
  const m = KITTY_PLAIN.exec(input);
  if (!m) return null;
  const mods = m[2] ? (Number(m[2]) - 1) & ~(64 | 128) : 0; // ignore Caps Lock / Num Lock
  const event = m[3] ?? '1';
  const code = Number(m[1]);
  if (mods !== 0 || event === '3' || code < 97 || code > 122) return null;
  return String.fromCharCode(code);
}
