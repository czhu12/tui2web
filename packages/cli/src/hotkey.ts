/** A key that shows the session link again while a full-screen app is running. */
export type Hotkey = { label: string; byte: string } | null;

export const DEFAULT_HOTKEY = 'ctrl-\\';

// Punctuation Ctrl combinations that terminals send as single control bytes.
const CTRL_PUNCTUATION: Record<string, string> = {
  '\\': '\x1c',
  backslash: '\x1c',
  ']': '\x1d',
  '^': '\x1e',
  '6': '\x1e',
  _: '\x1f',
  '/': '\x1f',
  '@': '\x00',
  space: '\x00',
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
  if (/^[a-z]$/.test(key)) return { label: `Ctrl+${key.toUpperCase()}`, byte: String.fromCharCode(key.charCodeAt(0) - 96) };
  const byte = CTRL_PUNCTUATION[key];
  if (byte === undefined) return undefined;
  const shown = key === 'backslash' ? '\\' : key === 'space' ? 'Space' : key;
  return { label: `Ctrl+${shown}`, byte };
}
