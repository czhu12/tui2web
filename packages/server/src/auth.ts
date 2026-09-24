import { scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { PasswordHash } from '@tui2web/protocol';

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * The hash comes from the CLI, i.e. untrusted input, so cap the scrypt cost
 * parameters to keep a malicious agent from making login attempts expensive.
 */
export function isAcceptablePasswordHash(h: unknown): h is PasswordHash {
  if (!h || typeof h !== 'object') return false;
  const p = h as Record<string, unknown>;
  return (
    p.algo === 'scrypt' &&
    typeof p.salt === 'string' &&
    typeof p.hash === 'string' &&
    Number.isInteger(p.N) && (p.N as number) >= 1024 && (p.N as number) <= 2 ** 17 &&
    Number.isInteger(p.r) && (p.r as number) >= 1 && (p.r as number) <= 16 &&
    Number.isInteger(p.p) && (p.p as number) >= 1 && (p.p as number) <= 4 &&
    Number.isInteger(p.keylen) && (p.keylen as number) >= 16 && (p.keylen as number) <= 64
  );
}

export function verifyPassword(password: string, h: PasswordHash): Promise<boolean> {
  return new Promise((resolve) => {
    scrypt(password, Buffer.from(h.salt, 'base64'), h.keylen, { N: h.N, r: h.r, p: h.p, maxmem: 256 * 1024 * 1024 }, (err, key) => {
      if (err) return resolve(false);
      const expected = Buffer.from(h.hash, 'base64');
      resolve(expected.length === key.length && timingSafeEqual(expected, key));
    });
  });
}

// ---- cookies ----------------------------------------------------------------

export function cookieName(sessionId: string): string {
  return `t2w_${sessionId}`;
}

export function parseCookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

export function authCookie(sessionId: string, value: string, secure: boolean): string {
  // Lax (not Strict) so opening the link from another app still sends the
  // cookie after the token redirect. Cross-site WebSocket use is blocked by the
  // Origin check instead.
  return [
    `${cookieName(sessionId)}=${value}`,
    `Path=/session/${sessionId}`,
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=2592000',
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

export function hasValidCookie(req: IncomingMessage, sessionId: string, expected: string): boolean {
  const value = parseCookies(req).get(cookieName(sessionId));
  return value !== undefined && safeEqual(value, expected);
}

/** Rejects cross-site WebSocket connections that would otherwise ride on the cookie. */
export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
