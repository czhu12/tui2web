import { randomBytes } from 'node:crypto';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import type { WebSocket, RawData } from 'ws';
import type { AgentToRelay, PasswordHash, RelayToAgent, RelayToViewer } from '@tui2web/protocol';

const { Terminal } = headless;
const { SerializeAddon } = serialize;

/** How long a session survives with its laptop disconnected. */
const AGENT_GRACE_MS = 10 * 60_000;
/** How long an exited session stays viewable (final screen + exit code). */
const ENDED_TTL_MS = 5 * 60_000;
const SNAPSHOT_SCROLLBACK = 1000;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_PER_WINDOW = 5;
const LOGIN_MAX_TOTAL = 50;

export function randomId(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

export function clampSize(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  const c = cols as number;
  const r = rows as number;
  if (c < 2 || r < 2 || c > 500 || r > 300) return null;
  return { cols: c, rows: r };
}

type Viewer = {
  ws: WebSocket;
  /** Live output queued while this viewer's snapshot is being produced. */
  pending: Buffer[] | null;
};

export class Session {
  readonly id = randomId(16);
  readonly token = randomId(32);
  readonly agentKey = randomId(32);
  /** Value of the viewer auth cookie for this session. */
  readonly cookieValue = randomId(32);
  readonly command: string;
  readonly password: PasswordHash | null;
  cols: number;
  rows: number;
  agent: WebSocket | null = null;
  ended: { code: number } | null = null;

  private viewers = new Set<Viewer>();
  // The relay keeps its own copy of the screen so new viewers see the current
  // state immediately instead of a blank terminal.
  private term: InstanceType<typeof Terminal>;
  private serializer = new SerializeAddon();
  private expiry: NodeJS.Timeout | null = null;
  private loginFailures: number[] = [];
  private totalLoginFailures = 0;
  private dispose: () => void;

  constructor(opts: { command: string; cols: number; rows: number; password: PasswordHash | null; dispose: () => void }) {
    this.command = opts.command;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.password = opts.password;
    this.dispose = opts.dispose;
    this.term = new Terminal({ cols: this.cols, rows: this.rows, scrollback: SNAPSHOT_SCROLLBACK, allowProposedApi: true });
    this.term.loadAddon(this.serializer);
  }

  // ---- agent side ---------------------------------------------------------

  attachAgent(ws: WebSocket) {
    if (this.agent && this.agent !== ws) this.agent.close(1000, 'replaced');
    this.agent = ws;
    this.clearExpiry();
    this.broadcastJson({ t: 'agent', connected: true });

    ws.on('message', (raw, isBinary) => {
      if (this.agent !== ws) return;
      if (isBinary) this.onOutput(toBuffer(raw));
      else this.onAgentControl(raw);
    });
    ws.on('close', () => {
      if (this.agent !== ws) return;
      this.agent = null;
      if (this.ended) return;
      this.broadcastJson({ t: 'agent', connected: false });
      this.scheduleExpiry(AGENT_GRACE_MS);
    });
  }

  sendAgent(msg: RelayToAgent) {
    this.agent?.send(JSON.stringify(msg));
  }

  setSize(cols: number, rows: number) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.term.resize(cols, rows);
    this.broadcastJson({ t: 'size', cols, rows });
  }

  private onAgentControl(raw: RawData) {
    let msg: AgentToRelay;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === 'size') {
      const size = clampSize(msg.cols, msg.rows);
      if (size) this.setSize(size.cols, size.rows);
    } else if (msg.t === 'exit') {
      this.end(Number.isInteger(msg.code) ? msg.code : 0);
    }
  }

  private onOutput(data: Buffer) {
    this.term.write(data);
    for (const v of this.viewers) {
      if (v.pending) v.pending.push(data);
      else v.ws.send(data);
    }
  }

  private end(code: number) {
    this.ended = { code };
    this.broadcastJson({ t: 'exit', code });
    this.agent?.close(1000, 'exited');
    this.agent = null;
    this.scheduleExpiry(ENDED_TTL_MS);
  }

  // ---- viewer side --------------------------------------------------------

  addViewer(ws: WebSocket) {
    const viewer: Viewer = { ws, pending: [] };
    this.viewers.add(viewer);
    this.sendJson(ws, {
      t: 'hello',
      command: this.command,
      cols: this.cols,
      rows: this.rows,
      agentConnected: this.agent !== null,
    });
    // xterm parses writes asynchronously. The empty write's callback fires once
    // everything written so far is applied, so the snapshot reflects exactly the
    // output up to this point; anything newer is queued in `pending`.
    this.term.write('', () => {
      if (!this.viewers.has(viewer)) return;
      this.sendJson(ws, { t: 'snapshot', data: this.serializer.serialize({ scrollback: SNAPSHOT_SCROLLBACK }) });
      for (const chunk of viewer.pending ?? []) ws.send(chunk);
      viewer.pending = null;
      if (this.ended) this.sendJson(ws, { t: 'exit', code: this.ended.code });
    });

    ws.on('message', (raw, isBinary) => {
      if (this.ended || !this.agent) return;
      if (isBinary) {
        this.agent.send(toBuffer(raw));
        return;
      }
      let msg: { t?: string; cols?: unknown; rows?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.t === 'resize') {
        const size = clampSize(msg.cols, msg.rows);
        // The agent applies it and answers with a `size` message.
        if (size) this.sendAgent({ t: 'resize', ...size });
      }
    });
    ws.on('close', () => this.viewers.delete(viewer));
  }

  private sendJson(ws: WebSocket, msg: RelayToViewer) {
    ws.send(JSON.stringify(msg));
  }

  private broadcastJson(msg: RelayToViewer) {
    const text = JSON.stringify(msg);
    for (const v of this.viewers) v.ws.send(text);
  }

  // ---- login rate limiting ------------------------------------------------

  canAttemptLogin(): boolean {
    const cutoff = Date.now() - LOGIN_WINDOW_MS;
    this.loginFailures = this.loginFailures.filter((t) => t > cutoff);
    return this.loginFailures.length < LOGIN_MAX_PER_WINDOW && this.totalLoginFailures < LOGIN_MAX_TOTAL;
  }

  recordLoginFailure() {
    this.loginFailures.push(Date.now());
    this.totalLoginFailures++;
  }

  // ---- lifetime -----------------------------------------------------------

  private scheduleExpiry(ms: number) {
    this.clearExpiry();
    this.expiry = setTimeout(() => this.destroy(), ms);
  }

  private clearExpiry() {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
  }

  destroy() {
    this.clearExpiry();
    this.agent?.close(1000, 'session expired');
    for (const v of this.viewers) v.ws.close(1000, 'session expired');
    this.viewers.clear();
    this.term.dispose();
    this.dispose();
  }
}

export class SessionStore {
  private sessions = new Map<string, Session>();

  create(opts: { command: string; cols: number; rows: number; password: PasswordHash | null }): Session {
    const session: Session = new Session({ ...opts, dispose: () => this.sessions.delete(session.id) });
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  get size() {
    return this.sessions.size;
  }
}

function toBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}
