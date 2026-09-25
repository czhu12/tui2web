#!/usr/bin/env node
// Stands in for the `tailscale` CLI in tests (TUI2WEB_TAILSCALE_BIN). Answers
// `status --json` with a tailnet whose address is loopback, so it runs anywhere.
//   FAKE_TAILSCALE_STATE  BackendState to report (default Running)
//   FAKE_TAILSCALE_MAGICDNS=0  report MagicDNS as off
if (process.argv[2] !== 'status' || process.argv[3] !== '--json') {
  process.stderr.write('fake tailscale: only `status --json` is supported\n');
  process.exit(2);
}
const state = process.env.FAKE_TAILSCALE_STATE || 'Running';
process.stdout.write(JSON.stringify({
  BackendState: state,
  Self: { DNSName: 'localhost.', HostName: 'test-machine', TailscaleIPs: state === 'Running' ? ['127.0.0.1', '::1'] : [] },
  CurrentTailnet: { MagicDNSEnabled: process.env.FAKE_TAILSCALE_MAGICDNS !== '0' },
}));
