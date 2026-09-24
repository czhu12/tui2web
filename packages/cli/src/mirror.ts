import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';

const { Terminal } = headless;
const { SerializeAddon } = serialize;

/**
 * An offscreen copy of the PTY's screen. If the relay restarts it loses its
 * own copy, and this is used to repaint it (and every phone) with the
 * current screen instead of a blank one.
 */
export class ScreenMirror {
  private term: InstanceType<typeof Terminal>;
  private serializer = new SerializeAddon();

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
    this.term.loadAddon(this.serializer);
  }

  write(data: string) {
    this.term.write(data);
  }

  resize(cols: number, rows: number) {
    this.term.resize(cols, rows);
  }

  /**
   * Serialized screen + scrollback as escape sequences. Reflects every write
   * made before this call (xterm parses asynchronously, so wait for the queue).
   */
  snapshot(): Promise<string> {
    return new Promise((resolve) => this.term.write('', () => resolve(this.serializer.serialize({ scrollback: 1000 }))));
  }
}
