/**
 * Tracks which mouse-reporting modes the app has turned on, from its output.
 *
 * While mouse reporting is on, terminals send clicks and drags to the app
 * instead of selecting text, so the link overlay can't be copied. The overlay
 * turns these off and, on close, turns back on exactly what the app had,
 * including the event encoding (e.g. SGR 1006), which the screen serializer
 * doesn't preserve.
 */
const MOUSE_MODES = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);
const DEC_MODE = /\x1b\[\?([\d;]+)([hl])/g;

export class MouseModes {
  private enabled = new Set<number>();
  // Keeps the end of the previous chunk, in case a sequence is split across two.
  private tail = '';

  observe(output: string) {
    const text = this.tail + output;
    for (const [, params, action] of text.matchAll(DEC_MODE)) {
      for (const p of params.split(';')) {
        const mode = Number(p);
        if (!MOUSE_MODES.has(mode)) continue;
        if (action === 'h') this.enabled.add(mode);
        else this.enabled.delete(mode);
      }
    }
    const lastEsc = text.lastIndexOf('\x1b');
    this.tail = lastEsc >= 0 && text.length - lastEsc < 32 && !/[hl]/.test(text.slice(lastEsc + 2)) ? text.slice(lastEsc) : '';
  }

  /** Turns all mouse reporting off, so the terminal selects text normally. */
  disableSequence(): string {
    return `\x1b[?${[...MOUSE_MODES].join(';')}l`;
  }

  /** Turns back on whatever the app currently has enabled. */
  restoreSequence(): string {
    return this.enabled.size ? `\x1b[?${[...this.enabled].join(';')}h` : '';
  }
}
