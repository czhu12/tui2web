import WebSocket from 'ws';
import type { AgentHello, AgentToRelay, RelayToAgent } from '@tui2web/protocol';

export type LinkState = 'connected' | 'connecting' | 'disconnected';
type SessionInfo = { id: string; agentKey: string; token: string; command: string; password: AgentHello['password'] };

/** Output produced while disconnected is replayed on reconnect, up to this much. */
const MAX_BACKLOG_BYTES = 1024 * 1024;
const REGISTER_TIMEOUT_MS = 10_000;

/** The relay couldn't be reached at all (offline, or it's down), as opposed to refusing the session. */
export class RelayUnreachable extends Error {}

/** Settles the first attempt of connect(). */
type Attempt = { resolve(): void; reject(err: Error): void };

export type LinkHandlers = {
  onInput(data: Buffer): void;
  onResize(cols: number, rows: number): void;
  /** The current screen, used to repaint a relay that restarted. */
  snapshot(): Promise<string>;
  /** Connected, connecting or disconnected changed. */
  onState?(): void;
};

/**
 * The agent's connection to the relay. Dials out (so it works behind NAT, like
 * ngrok) and keeps the session alive across network blips by resuming with the
 * session's agent key. If the relay restarted and forgot the session, the
 * resume recreates it under the same id and token.
 *
 * The user can also disconnect on purpose: the relay then forgets the session
 * until connect() restores it, again under the same id and token, so the link
 * never changes.
 */
export class RelayLink {
  /** Set once the session is gone for good (e.g. relay restarted). */
  lostReason: string | null = null;

  private agentUrl: string;
  private handlers: LinkHandlers;
  private ws: WebSocket | null = null;
  private ready = false;
  private finished = false;
  private paused = false;
  /** A resume attempt that hasn't been answered yet. */
  private pending: WebSocket | null = null;
  private session: SessionInfo | null = null;
  private size = { cols: 80, rows: 24 };
  private backlog: Buffer[] = [];
  private backlogBytes = 0;
  private retries = 0;

  constructor(relay: string, handlers: LinkHandlers) {
    this.agentUrl = agentUrl(relay);
    this.handlers = handlers;
  }

  /** Points a link that hasn't connected yet at its relay, e.g. once Tailscale is up. */
  setRelay(relay: string) {
    this.agentUrl = agentUrl(relay);
  }

  /** Opens the first connection and creates the session. Resolves with the share URL. */
  register(hello: AgentHello): Promise<{ id: string; url: string }> {
    this.size = { cols: hello.cols, rows: hello.rows };
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.agentUrl);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new RelayUnreachable(`timed out connecting to ${this.agentUrl}`));
      }, REGISTER_TIMEOUT_MS);

      ws.on('open', () => ws.send(JSON.stringify(hello)));
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(new RelayUnreachable(`could not reach relay at ${this.agentUrl} (${errorText(err)})`));
      });
      ws.once('message', (raw) => {
        clearTimeout(timer);
        const msg = parse(raw);
        if (msg?.t !== 'registered') {
          ws.terminate();
          return reject(new Error(msg?.t === 'error' ? msg.message : 'unexpected reply from relay'));
        }
        this.session = { id: msg.id, agentKey: msg.agentKey, token: msg.token, command: hello.command, password: hello.password };
        this.adopt(ws, []);
        resolve({ id: msg.id, url: msg.url });
      });
    });
  }

  get state(): LinkState {
    if (this.paused) return 'disconnected';
    return this.ready && this.ws?.readyState === WebSocket.OPEN ? 'connected' : 'connecting';
  }

  /**
   * Starts disconnected, with an identity made here rather than by the relay,
   * so the link is known before anything is sent. connect() creates the
   * session on the relay under it.
   */
  prepare(session: SessionInfo, size: { cols: number; rows: number }) {
    this.session = session;
    this.size = size;
    this.paused = true;
  }

  /** Removes the session from the relay. The link keeps working after connect(). */
  disconnect() {
    if (this.paused || this.finished) return;
    this.paused = true;
    this.backlog = [];
    this.backlogBytes = 0;
    this.pending?.terminate();
    this.pending = null;
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'pause' } satisfies AgentToRelay));
      ws.close(1000);
    } else ws?.terminate();
    this.handlers.onState?.();
  }

  /**
   * Puts the session back on the relay under the same id and token. Makes one
   * attempt: resolves once connected, or rejects and stays disconnected if the
   * relay can't be reached. (Once connected, drops reconnect on their own.)
   */
  connect(): Promise<void> {
    if (!this.paused || this.finished) return Promise.resolve();
    this.paused = false;
    this.retries = 0;
    return new Promise((resolve, reject) => {
      this.resume({ resolve, reject });
      this.handlers.onState?.();
    });
  }

  sendOutput(data: Buffer) {
    // While disconnected nothing is kept: connect() repaints from the mirror.
    if (this.paused) return;
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
      return;
    }
    this.backlog.push(data);
    this.backlogBytes += data.length;
    while (this.backlogBytes > MAX_BACKLOG_BYTES && this.backlog.length > 1) {
      this.backlogBytes -= this.backlog.shift()!.length;
    }
  }

  sendSize(cols: number, rows: number) {
    this.size = { cols, rows };
    this.sendControl({ t: 'size', cols, rows });
  }

  /** Reports the exit code and closes. Resolves once the message is flushed. */
  finish(code: number): Promise<void> {
    this.finished = true;
    const ws = this.ws;
    if (!ws || !this.ready || ws.readyState !== WebSocket.OPEN) {
      ws?.terminate();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = setTimeout(resolve, 1500);
      ws.once('close', () => {
        clearTimeout(done);
        resolve();
      });
      ws.send(JSON.stringify({ t: 'exit', code } satisfies AgentToRelay));
      ws.close(1000);
    });
  }

  private sendControl(msg: AgentToRelay) {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Wires up a connection that has completed its hello/resume handshake. */
  private adopt(ws: WebSocket, preamble: Buffer[]) {
    this.ws = ws;
    this.ready = true;
    this.retries = 0;
    for (const chunk of preamble) ws.send(chunk);
    for (const chunk of this.backlog) ws.send(chunk);
    this.backlog = [];
    this.backlogBytes = 0;
    this.handlers.onState?.();

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return this.handlers.onInput(raw as Buffer);
      const msg = parse(raw);
      if (msg?.t === 'resize') this.handlers.onResize(msg.cols, msg.rows);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ready = false;
      this.ws = null;
      if (!this.finished && !this.paused) this.scheduleReconnect();
      this.handlers.onState?.();
    });
    ws.on('error', () => {});
  }

  private scheduleReconnect() {
    const delay = Math.min(30_000, 500 * 2 ** this.retries++);
    setTimeout(() => this.resume(), delay).unref();
  }

  /** `attempt`: this is connect()'s one try, so report failure instead of retrying. */
  private resume(attempt?: Attempt) {
    if (this.finished || this.paused || !this.session || this.pending) return attempt?.resolve();
    const { id, agentKey, token, command, password } = this.session;
    const ws = new WebSocket(this.agentUrl);
    this.pending = ws;
    let settled = false;
    const timer = attempt && setTimeout(() => retry(new Error('timed out')), REGISTER_TIMEOUT_MS);
    const retry = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (this.pending === ws) this.pending = null;
      ws.terminate();
      if (attempt) {
        if (this.paused) return attempt.resolve(); // disconnected meanwhile, on purpose
        this.paused = true;
        this.handlers.onState?.();
        return attempt.reject(new RelayUnreachable(`could not reach relay at ${this.agentUrl} (${err ? errorText(err) : 'connection closed'})`));
      }
      if (!this.paused) this.scheduleReconnect();
    };
    ws.on('open', () =>
      ws.send(JSON.stringify({ t: 'resume', id, agentKey, ...this.size, restore: { token, command, password } } satisfies AgentToRelay)),
    );
    const onError = (err: Error) => retry(err);
    const onClose = () => retry();
    ws.on('error', onError);
    ws.on('close', onClose);
    ws.once('message', (raw) => {
      const msg = parse(raw);
      if (this.pending !== ws) return; // disconnected meanwhile
      this.pending = null;
      clearTimeout(timer);
      if (msg?.t === 'resumed') {
        settled = true;
        ws.off('error', onError);
        ws.off('close', onClose);
        attempt?.resolve();
        if (!msg.restored) return this.adopt(ws, []);
        // The relay starts from a blank screen. Repaint it from our mirror;
        // the snapshot already includes everything in the backlog, so drop it.
        // Output produced while the snapshot is taken lands in the new backlog.
        this.backlog = [];
        this.backlogBytes = 0;
        this.handlers.snapshot().then((screen) => {
          if (this.paused) {
            ws.send(JSON.stringify({ t: 'pause' } satisfies AgentToRelay));
            return ws.close(1000);
          }
          if (ws.readyState !== WebSocket.OPEN) return this.scheduleReconnect();
          this.adopt(ws, [Buffer.from(screen, 'utf8')]);
        });
      } else if (msg?.t === 'error') {
        // The relay no longer knows this session; keep running locally.
        settled = true;
        this.finished = true;
        this.lostReason = msg.message;
        ws.terminate();
        attempt?.reject(new Error(`the relay refused the session: ${msg.message}`));
        this.handlers.onState?.();
      } else retry();
    });
  }
}

/** Offline errors often have no message, only a code (e.g. ENOTFOUND from DNS). */
function errorText(err: Error): string {
  return err.message || (err as NodeJS.ErrnoException).code || 'connection failed';
}

function agentUrl(relay: string): string {
  return relay.replace(/^http/, 'ws').replace(/\/+$/, '') + '/agent';
}

function parse(raw: WebSocket.RawData): RelayToAgent | null {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}
