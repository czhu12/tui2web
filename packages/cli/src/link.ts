import WebSocket from 'ws';
import type { AgentHello, AgentToRelay, RelayToAgent } from '@tui2web/protocol';

/** Output produced while disconnected is replayed on reconnect, up to this much. */
const MAX_BACKLOG_BYTES = 1024 * 1024;
const REGISTER_TIMEOUT_MS = 10_000;

export type LinkHandlers = {
  onInput(data: Buffer): void;
  onResize(cols: number, rows: number): void;
  /** The current screen, used to repaint a relay that restarted. */
  snapshot(): Promise<string>;
};

/**
 * The agent's connection to the relay. Dials out (so it works behind NAT, like
 * ngrok) and keeps the session alive across network blips by resuming with the
 * session's agent key. If the relay restarted and forgot the session, the
 * resume recreates it under the same id and token.
 */
export class RelayLink {
  /** Set once the session is gone for good (e.g. relay restarted). */
  lostReason: string | null = null;

  private agentUrl: string;
  private handlers: LinkHandlers;
  private ws: WebSocket | null = null;
  private ready = false;
  private finished = false;
  private session: { id: string; agentKey: string; token: string; command: string; password: AgentHello['password'] } | null = null;
  private size = { cols: 80, rows: 24 };
  private backlog: Buffer[] = [];
  private backlogBytes = 0;
  private retries = 0;

  constructor(relay: string, handlers: LinkHandlers) {
    this.agentUrl = relay.replace(/^http/, 'ws').replace(/\/+$/, '') + '/agent';
    this.handlers = handlers;
  }

  /** Opens the first connection and creates the session. Resolves with the share URL. */
  register(hello: AgentHello): Promise<{ id: string; url: string }> {
    this.size = { cols: hello.cols, rows: hello.rows };
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.agentUrl);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`timed out connecting to ${this.agentUrl}`));
      }, REGISTER_TIMEOUT_MS);

      ws.on('open', () => ws.send(JSON.stringify(hello)));
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`could not reach relay at ${this.agentUrl} (${err.message})`));
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

  sendOutput(data: Buffer) {
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

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return this.handlers.onInput(raw as Buffer);
      const msg = parse(raw);
      if (msg?.t === 'resize') this.handlers.onResize(msg.cols, msg.rows);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ready = false;
      this.ws = null;
      if (!this.finished) this.scheduleReconnect();
    });
    ws.on('error', () => {});
  }

  private scheduleReconnect() {
    const delay = Math.min(30_000, 500 * 2 ** this.retries++);
    setTimeout(() => this.resume(), delay).unref();
  }

  private resume() {
    if (this.finished || !this.session) return;
    const { id, agentKey, token, command, password } = this.session;
    const ws = new WebSocket(this.agentUrl);
    let settled = false;
    const retry = () => {
      if (settled) return;
      settled = true;
      ws.terminate();
      this.scheduleReconnect();
    };
    ws.on('open', () =>
      ws.send(JSON.stringify({ t: 'resume', id, agentKey, ...this.size, restore: { token, command, password } } satisfies AgentToRelay)),
    );
    ws.on('error', retry);
    ws.on('close', retry);
    ws.once('message', (raw) => {
      const msg = parse(raw);
      if (msg?.t === 'resumed') {
        settled = true;
        ws.off('error', retry);
        ws.off('close', retry);
        if (!msg.restored) return this.adopt(ws, []);
        // The relay starts from a blank screen. Repaint it from our mirror;
        // the snapshot already includes everything in the backlog, so drop it.
        // Output produced while the snapshot is taken lands in the new backlog.
        this.backlog = [];
        this.backlogBytes = 0;
        this.handlers.snapshot().then((screen) => {
          if (ws.readyState !== WebSocket.OPEN) return this.scheduleReconnect();
          this.adopt(ws, [Buffer.from(screen, 'utf8')]);
        });
      } else if (msg?.t === 'error') {
        // The relay no longer knows this session; keep running locally.
        settled = true;
        this.finished = true;
        this.lostReason = msg.message;
        ws.terminate();
      } else retry();
    });
  }
}

function parse(raw: WebSocket.RawData): RelayToAgent | null {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}
