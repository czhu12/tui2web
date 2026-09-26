import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.ts';

/**
 * Running sessions, one private file each, so `tui2web ls` in another terminal
 * can show links for sessions whose full-screen app has hidden them.
 */
const SESSIONS_DIR = join(CONFIG_DIR, 'sessions');

/** `url` is null until the link is known (Tailscale mode, before Tailscale is up). */
export type SessionRecord = { pid: number; url: string | null; command: string; cwd: string; startedAt: string };

/** Records this session. Returns a function that updates its link. */
export function registerSession(record: Omit<SessionRecord, 'pid' | 'startedAt'>): (url: string) => void {
  mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  const file = join(SESSIONS_DIR, `${process.pid}.json`);
  const full: SessionRecord = { pid: process.pid, startedAt: new Date().toISOString(), ...record };
  // The URL contains the session token, so keep the file private.
  const write = () => writeFileSync(file, JSON.stringify(full, null, 2) + '\n', { mode: 0o600 });
  write();
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    try {
      unlinkSync(file);
    } catch {}
  };
  process.on('exit', remove);
  return (url) => {
    full.url = url;
    if (!removed) write();
  };
}

/** Live sessions, newest first. Files left behind by crashed processes are cleaned up. */
export function listSessions(): SessionRecord[] {
  let names: string[];
  try {
    names = readdirSync(SESSIONS_DIR).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const live: SessionRecord[] = [];
  for (const name of names) {
    const file = join(SESSIONS_DIR, name);
    try {
      const record: SessionRecord = JSON.parse(readFileSync(file, 'utf8'));
      if (isAlive(record.pid)) live.push(record);
      else unlinkSync(file);
    } catch {}
  }
  return live.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
