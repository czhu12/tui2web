import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { CLOSE_NOT_FOUND, CLOSE_UNAUTHORIZED, type AgentToRelay, type RelayToAgent } from '@tui2web/protocol';
import { authCookie, hasValidCookie, isAcceptablePasswordHash, isSameOrigin, safeEqual, verifyPassword } from './auth.ts';
import { loginPage, messagePage } from './pages.ts';
import { clampSize, isValidIdentity, SessionStore, type Session } from './sessions.ts';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '');
const WEB_DIST = process.env.WEB_DIST ?? fileURLToPath(new URL('../../web/dist/', import.meta.url));

const store = new SessionStore();
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

const SESSION_PATH = /^\/session\/([A-Za-z0-9_-]{16,64})(\/login|\/ws)?\/?$/;

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

  if (url.pathname === '/') {
    return serveStatic(res, '/landing.html');
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
  if (!match) return send(res, 404, 'text/html; charset=utf-8', messagePage('Not found', 'Nothing here.'));
  const [, id, sub] = match;
  const session = store.get(id);
  res.setHeader('Cache-Control', 'no-store');
  if (!session) {
    return send(res, 404, 'text/html; charset=utf-8', messagePage('Session not found', 'This session has ended or never existed.'));
  }

  if (sub === '/login' && req.method === 'POST') return handleLogin(req, res, session);
  if (sub || req.method !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');

  // Jupyter-style: a valid ?token= sets the cookie and redirects to the bare
  // URL, so the token leaves the address bar immediately.
  const token = url.searchParams.get('token');
  if (token !== null) {
    if (safeEqual(token, session.token)) return grantAndRedirect(req, res, session);
    return send(res, 401, 'text/html; charset=utf-8', renderLogin(session, 'That link’s token is not valid for this session.'));
  }

  if (!hasValidCookie(req, session.id, session.cookieValue)) {
    const error = url.searchParams.has('error') ? 'Incorrect password or token.' : url.searchParams.has('locked') ? 'Too many attempts. Try again in a minute.' : null;
    return send(res, 401, 'text/html; charset=utf-8', renderLogin(session, error));
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

function renderLogin(session: Session, error: string | null): string {
  return loginPage({ sessionId: session.id, command: session.command, passwordEnabled: session.password !== null, error });
}

function isHttps(req: IncomingMessage): boolean {
  return PUBLIC_URL.startsWith('https:') || req.headers['x-forwarded-proto'] === 'https';
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
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
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
    wss.handleUpgrade(req, socket, head, handleAgent);
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

function handleAgent(ws: WebSocket) {
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
      reply({ t: 'registered', id: session.id, agentKey: session.agentKey, token: session.token, url: `${PUBLIC_URL}/session/${session.id}?token=${session.token}` });
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
      console.log(`restored session after relay restart (${store.size} active)`);
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
setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.get(ws)) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, 30_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`tui2web relay listening on ${HOST}:${PORT} (public URL ${PUBLIC_URL})`);
});

// As PID 1 in a container, Node gets no default signal handling.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, closing ${wss.clients.size} connections`);
    for (const ws of wss.clients) ws.close(1001, 'relay restarting');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
