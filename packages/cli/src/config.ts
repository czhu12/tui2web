import { randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PasswordHash } from '@tui2web/protocol';

export const CONFIG_DIR = join(homedir(), '.tui2web');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export type Config = {
  relay?: string;
  password?: PasswordHash;
  /** Key that shows the link again, e.g. "ctrl-\\" (default) or "none". */
  hotkey?: string;
};

export function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveConfig(config: Config) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600);
}

// N=2^15 keeps a login check around 50-100ms on the relay, cheap for one
// person but slow for anyone guessing.
export function hashPassword(password: string): PasswordHash {
  const params = { N: 2 ** 15, r: 8, p: 1, keylen: 32 };
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: 128 * 1024 * 1024 });
  return { algo: 'scrypt', salt: salt.toString('base64'), hash: hash.toString('base64'), ...params };
}

/** Reads a line from the TTY without echoing it. */
export function promptHidden(question: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) throw new Error('set-password needs an interactive terminal');
  return new Promise((resolve, reject) => {
    let value = '';
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          stdout.write('\n');
          return resolve(value);
        } else if (ch === '\u0003') {
          cleanup();
          stdout.write('\n');
          return reject(new Error('cancelled'));
        } else if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
        } else if (ch >= ' ') {
          value += ch;
        }
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}
