#!/usr/bin/env node
// Stands in for the `tailscale` CLI in tests (TUI2WEB_TAILSCALE_BIN). Answers
// `status --json` with a tailnet whose address is loopback, so it runs anywhere.
//   FAKE_TAILSCALE_STATE  BackendState to report (default Running)
//   FAKE_TAILSCALE_STATE_FILE  read the BackendState from this file instead, if it
//                              exists, so a test can bring Tailscale up mid-session
//   FAKE_TAILSCALE_DELAY  answer after this many milliseconds (a slow or hung daemon)
//   FAKE_TAILSCALE_MAGICDNS=0  report MagicDNS as off
//   FAKE_TAILSCALE_DOWN=1  the daemon isn't running: fail with an error, no JSON
//   FAKE_TAILSCALE_EXIT=1  exit 1 after printing the JSON, as real tailscale does when not running
import { existsSync, readFileSync } from 'node:fs';

if (process.argv[2] !== 'status' || process.argv[3] !== '--json') {
  process.stderr.write('fake tailscale: only `status --json` is supported\n');
  process.exit(2);
}
if (process.env.FAKE_TAILSCALE_DOWN === '1') {
  process.stderr.write("failed to connect to local tailscaled; it doesn't appear to be running\n");
  process.exit(1);
}
if (process.env.FAKE_TAILSCALE_DELAY) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_TAILSCALE_DELAY)));
const file = process.env.FAKE_TAILSCALE_STATE_FILE;
const state = (file && existsSync(file) && readFileSync(file, 'utf8').trim()) || process.env.FAKE_TAILSCALE_STATE || 'Running';
process.stdout.write(JSON.stringify({
  BackendState: state,
  Self: { DNSName: 'localhost.', HostName: 'test-machine', TailscaleIPs: state === 'Running' ? ['127.0.0.1', '::1'] : [] },
  CurrentTailnet: { MagicDNSEnabled: process.env.FAKE_TAILSCALE_MAGICDNS !== '0' },
}));
if (process.env.FAKE_TAILSCALE_EXIT === '1') process.exitCode = 1;
