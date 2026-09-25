import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Relay = { listening: Promise<void>; close(): Promise<void> };
type StartRelay = (opts: { port: number; host?: string | string[]; publicUrl?: string; webDist: string; log?: (message: string) => void }) => Relay;

export const DEFAULT_RELAY_PORT = 8787;
/** How many ports a per-session relay tries, counting up from the first. */
const PORT_SCAN = 100;

/**
 * Loads the relay server. Published package: it's compiled into dist/relay
 * with the web viewer in dist/web. Running from the repo: use the sources.
 */
async function loadRelay(): Promise<{ startRelay: StartRelay; webDist: string }> {
  const compiled = new URL('./relay/relay.js', import.meta.url);
  const fromDist = existsSync(fileURLToPath(compiled));
  const source = '../../server/src/relay.ts';
  const { startRelay }: { startRelay: StartRelay } = await import(fromDist ? compiled.href : source);
  const webDist = fileURLToPath(new URL(fromDist ? './web/' : '../../web/dist/', import.meta.url));
  return { startRelay, webDist };
}

export type RelayOptions = {
  port: number;
  host?: string | string[];
  /** Base URL for session links, given the port that was bound. */
  publicUrl?: (port: number) => string;
  /** Try the following ports too when `port` is taken. */
  scan?: boolean;
  log?: (message: string) => void;
};

/** Starts a relay in this process. Resolves once it's listening, with the port it got. */
export async function startLocalRelay(opts: RelayOptions): Promise<{ relay: Relay; port: number }> {
  const { startRelay, webDist } = await loadRelay();
  const last = opts.scan ? Math.min(65535, opts.port + PORT_SCAN - 1) : opts.port;
  for (let port = opts.port; ; port++) {
    const relay = startRelay({ port, host: opts.host, publicUrl: opts.publicUrl?.(port), webDist, log: opts.log });
    try {
      await relay.listening;
      return { relay, port };
    } catch (err) {
      await relay.close();
      const inUse = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (!inUse || port >= last) {
        if (inUse && opts.scan) throw new Error(`ports ${opts.port}-${last} are all in use`);
        throw err;
      }
    }
  }
}
