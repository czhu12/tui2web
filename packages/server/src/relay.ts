import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AgentToRelay, CloseNotFound, CloseUnauthorized, RelayToAgent } from '@tui2web/protocol';
import { authCookie, hasValidCookie, isAcceptablePasswordHash, isSameOrigin, safeEqual, verifyPassword } from './auth.ts';
import { loginPage, messagePage } from './pages.ts';
import { clampSize, isValidIdentity, SessionStore, type Session } from './sessions.ts';

// Values, not imports: the relay also ships inside the tui2web npm package,
// where the private protocol package doesn't exist. The types keep them in sync.
const CLOSE_UNAUTHORIZED: CloseUnauthorized = 4401;
const CLOSE_NOT_FOUND: CloseNotFound = 4404;

export type RelayOptions = {
  port: number;
  /** Interface to bind. Default '::' (IPv6 and IPv4), falling back to 0.0.0.0. */
  host?: string;
  /**
   * Base URL for session links, e.g. https://tui2web.com. When omitted it's
   * taken from each request's Host and X-Forwarded-Proto headers, so the relay
   * works behind a proxy or tunnel (e.g. Cloudflare) without configuration.
   */
  publicUrl?: string;
  /** Directory with the built web viewer and landing page. */
  webDist: string;
  log?: (message: string) => void;
};

export type Relay = {
  /** Resolves once the relay is accepting connections; rejects if it can't listen. */
  listening: Promise<void>;
  close(): Promise<void>;
};

export function startRelay(opts: RelayOptions): Relay {
  const PORT = opts.port;
  const PUBLIC_URL = opts.publicUrl?.replace(/\/+$/, '');
  const WEB_DIST = opts.webDist;
  const log = opts.log ?? console.log;

  const store = new SessionStore();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  const SESSION_PATH = /^\/session\/([A-Za-z0-9_-]{16,64})(\/login|\/ws)?\/?$/;

  /** Files from the web build served at the site root (crawlers and link previews expect them there). */
  const ROOT_FILES: Record<string, string> = {
    '/robots.txt': '/robots.txt',
    '/sitemap.xml': '/sitemap.xml',
    '/og.png': '/og.png',
    '/favicon.svg': '/favicon.svg',
    '/favicon-32.png': '/favicon-32.png',
    '/favicon.ico': '/favicon-32.png',
    '/apple-touch-icon.png': '/apple-touch-icon.png',
  };

  // ---- HTTP -------------------------------------------------------------------

  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Internal error');
      else res.end();
    });
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse) {
    // Never log req.url: it can contain a session token.
    const url = new URL(req.url ?? '/', 'http://relay');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    // One canonical host for search engines: www.tui2web.com -> tui2web.com.
    const host = req.headers.host ?? '';
    if (host.startsWith('www.')) {
      res.writeHead(301, { Location: `${isHttps(req) ? 'https' : 'http'}://${host.slice(4)}${req.url ?? '/'}` });
      return res.end();
    }

    const rootFile = ROOT_FILES[url.pathname];
    // Only the homepage belongs in search results; never session pages.
    if (url.pathname !== '/' && !rootFile) res.setHeader('X-Robots-Tag', 'noindex, nofollow');

    if (url.pathname === '/') {
      return serveStatic(res, '/landing.html');
    }
    if (rootFile && (req.method === 'GET' || req.method === 'HEAD')) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return serveStatic(res, rootFile);
    }
    if (url.pathname === '/healthz') {
      const mem = process.memoryUsage();
      const mb = (n: number) => Math.round(n / 1024 / 1024);
      return send(res, 200, 'text/plain; charset=utf-8', `ok sessions=${store.size} heapMB=${mb(mem.heapUsed)} buffersMB=${mb(mem.arrayBuffers)} rssMB=${mb(mem.rss)}`);
    }
    if (url.pathname.startsWith('/assets/') && req.method === 'GET') {
      return serveStatic(res, url.pathname);
    }

    const match = SESSION_PATH.exec(url.pathname);
    if (!match) return send(res, 404, 'text/html; charset=utf-8', messagePage('Not found', 'Nothing here.', baseUrl(req)));
    const [, id, sub] = match;
    const session = store.get(id);
    res.setHeader('Cache-Control', 'no-store');
    if (!session) {
      return send(res, 404, 'text/html; charset=utf-8', messagePage('Session not found', 'This session has ended or never existed.', baseUrl(req)));
    }

    if (sub === '/login' && req.method === 'POST') return handleLogin(req, res, session);
    if (sub || req.method !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');

    // Jupyter-style: a valid ?token= sets the cookie and redirects to the bare
    // URL, so the token leaves the address bar immediately.
    const token = url.searchParams.get('token');
    if (token !== null) {
      if (safeEqual(token, session.token)) return grantAndRedirect(req, res, session);
      return send(res, 401, 'text/html; charset=utf-8', renderLogin(req, session, 'That link’s token is not valid for this session.'));
    }

    if (!hasValidCookie(req, session.id, session.cookieValue)) {
      const error = url.searchParams.has('error') ? 'Incorrect password or token.' : url.searchParams.has('locked') ? 'Too many attempts. Try again in a minute.' : null;
      return send(res, 401, 'text/html; charset=utf-8', renderLogin(req, session, error));
    }

    return serveStatic(res, '/index.html');
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse, session: Session) {
    const body = await readBody(req, 4096);
    const secret = new URLSearchParams(body ?? '').get('secret') ?? '';
    const back = `/session/${session.id}`;

    if (!session.canAttemptLogin()) return redirect(res, `${back}?locked`);

    const ok = safeEqual(secret, session.token) || (session.password !== null && secret.length > 0 && (await verifyPassword(secret, session.password)));
    if (!ok) {
      session.recordLoginFailure();
      return redirect(res, `${back}?error`);
    }
    return grantAndRedirect(req, res, session);
  }

  function grantAndRedirect(req: IncomingMessage, res: ServerResponse, session: Session) {
    res.setHeader('Set-Cookie', authCookie(session.id, session.cookieValue, isHttps(req)));
    redirect(res, `/session/${session.id}`);
  }

  function renderLogin(req: IncomingMessage, session: Session, error: string | null): string {
    return loginPage({ sessionId: session.id, command: session.command, passwordEnabled: session.password !== null, error, base: baseUrl(req) });
  }

  function isHttps(req: IncomingMessage): boolean {
    if (PUBLIC_URL) return PUBLIC_URL.startsWith('https:');
    return req.headers['x-forwarded-proto'] === 'https' || (req.socket as TLSSocket).encrypted === true;
  }

  /** The URL people reach this relay at, e.g. https://tui2web.com. */
  function baseUrl(req: IncomingMessage): string {
    return PUBLIC_URL ?? `${isHttps(req) ? 'https' : 'http'}://${req.headers.host ?? `localhost:${PORT}`}`;
  }

  // ---- static files (built web viewer) ------------------------------------------

  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.json': 'application/json',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
  };

  async function serveStatic(res: ServerResponse, pathname: string) {
    const file = normalize(join(WEB_DIST, pathname));
    if (!file.startsWith(normalize(WEB_DIST + sep))) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    try {
      const body = await readFile(file);
      // Vite fingerprints everything under /assets, so those can be cached forever.
      if (pathname.startsWith('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      send(res, 200, MIME[extname(file)] ?? 'application/octet-stream', body);
    } catch {
      const hint = pathname === '/index.html' ? 'Web viewer not built. Run `npm run build` first.' : 'Not found';
      send(res, 404, 'text/plain; charset=utf-8', hint);
    }
  }

  // ---- helpers ----------------------------------------------------------------------

  function send(res: ServerResponse, status: number, type: string, body: string | Buffer) {
    // Content-Length lets crawlers (e.g. link-preview bots) size the image
    // without downloading it; HEAD gets the headers only.
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
    res.end(res.req.method === 'HEAD' ? undefined : body);
  }

  function redirect(res: ServerResponse, location: string) {
    res.writeHead(303, { Location: location });
    res.end();
  }

  function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
    return new Promise((resolve) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          resolve(null);
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(null));
    });
  }

  // ---- WebSockets -------------------------------------------------------------------

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://relay');

    if (pathname === '/agent') {
      wss.handleUpgrade(req, socket, head, (ws) => handleAgent(ws, baseUrl(req)));
      return;
    }

    const match = SESSION_PATH.exec(pathname);
    if (!match || match[2] !== '/ws' || !isSameOrigin(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Accept, then close with a specific code, so the viewer can tell
      // "log in again" apart from "session is gone".
      const session = store.get(match[1]);
      if (!session) return ws.close(CLOSE_NOT_FOUND, 'session not found');
      if (!hasValidCookie(req, session.id, session.cookieValue)) return ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
      trackAlive(ws);
      session.addViewer(ws);
    });
  });

  function handleAgent(ws: WebSocket, base: string) {
    trackAlive(ws);
    const reply = (msg: RelayToAgent) => ws.send(JSON.stringify(msg));
    const fail = (message: string) => {
      reply({ t: 'error', message });
      ws.close(1008, message.slice(0, 100));
    };

    ws.once('message', (raw, isBinary) => {
      let msg: AgentToRelay;
      try {
        if (isBinary) throw new Error('binary');
        msg = JSON.parse(raw.toString());
      } catch {
        return fail('expected hello');
      }

      if (msg.t === 'hello') {
        const size = clampSize(msg.cols, msg.rows);
        if (!size) return fail('invalid terminal size');
        if (msg.password !== null && !isAcceptablePasswordHash(msg.password)) return fail('invalid password hash');
        const session = store.create({ command: String(msg.command).slice(0, 200), ...size, password: msg.password });
        session.attachAgent(ws);
        reply({ t: 'registered', id: session.id, agentKey: session.agentKey, token: session.token, url: `${base}/session/${session.id}?token=${session.token}` });
        return;
      }

      if (msg.t === 'resume') {
        const size = clampSize(msg.cols, msg.rows);
        const existing = store.get(String(msg.id));
        if (existing) {
          if (existing.ended || !safeEqual(String(msg.agentKey), existing.agentKey)) return fail('session not found');
          existing.attachAgent(ws);
          reply({ t: 'resumed', restored: false });
          if (size) existing.setSize(size.cols, size.rows);
          return;
        }
        // Unknown session: the relay restarted or was redeployed. Recreate it
        // under the same identity so the printed link and phone logins still work.
        const restore = msg.restore;
        const identity = { id: msg.id, token: restore?.token, agentKey: msg.agentKey };
        if (!restore || !size || !isValidIdentity(identity)) return fail('session not found');
        if (restore.password !== null && !isAcceptablePasswordHash(restore.password)) return fail('invalid password hash');
        const session = store.create({ command: String(restore.command).slice(0, 200), ...size, password: restore.password }, identity);
        session.attachAgent(ws);
        reply({ t: 'resumed', restored: true });
        log(`restored session after relay restart (${store.size} active)`);
        return;
      }

      fail('expected hello');
    });
  }

  // Drop connections that silently died (phones sleeping, laptops closing lids).
  const alive = new WeakMap<WebSocket, boolean>();
  function trackAlive(ws: WebSocket) {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    ws.on('error', () => ws.terminate());
  }
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 30_000).unref();

  // Default '::' accepts IPv6 and IPv4. With only '0.0.0.0', clients that
  // resolve localhost to ::1 first (Node 17-19, among others) are refused.
  let host = opts.host ?? '::';
  const listening = new Promise<void>((resolve, reject) => {
    server.on('listening', () => {
      log(`tui2web relay listening on ${host}:${PORT} (public URL ${PUBLIC_URL ?? 'taken from each request'})`);
      resolve();
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      // Hosts with IPv6 disabled (common in containers) can't bind '::'.
      if (!opts.host && host === '::' && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
        log('IPv6 unavailable, listening on IPv4 only');
        host = '0.0.0.0';
        server.listen(PORT, host);
      } else reject(err);
    });
  });
  server.listen(PORT, host);

  return {
    listening,
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(1001, 'relay restarting');
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
