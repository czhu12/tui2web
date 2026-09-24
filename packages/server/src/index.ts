// Relay entry point for the Docker image and `npm run relay`, configured
// through environment variables. The same relay also runs via `tui2web relay`.
import { fileURLToPath } from 'node:url';
import { startRelay } from './relay.ts';

const relay = startRelay({
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST,
  publicUrl: process.env.PUBLIC_URL,
  webDist: process.env.WEB_DIST ?? fileURLToPath(new URL('../../web/dist/', import.meta.url)),
});

relay.listening.catch((err: Error) => {
  console.error(`Could not start the relay: ${err.message}`);
  process.exit(1);
});

// As PID 1 in a container, Node gets no default signal handling.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    relay.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
