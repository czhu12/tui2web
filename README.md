# tui2web

Open a terminal program on your phone:

```
$ tui2web claude --continue

tui2web session is live:

  https://tui2web.com/session/o3p2fpme-mPHaLieL-4ifw?token=…
```

## How it works

```
laptop: tui2web CLI ──WSS (outbound)──► relay (packages/server) ◄──WSS── phone: web viewer (packages/web)
        runs the command in a PTY        pairs sessions, keeps a           xterm.js + extra keys
                                         headless copy of the screen
```

- **CLI** (`packages/cli`) runs the command in a pseudo-terminal, mirrors it in your local terminal, and streams it to the relay. The laptop dials out, so there are no open ports and it works behind NAT. If the network drops, it reconnects and replays missed output.
- **Relay** (`packages/server`) creates sessions, handles auth, and keeps a headless xterm per session, so a phone that connects late sees the current screen straight away.
- **Viewer** (`packages/web`) is xterm.js plus a mobile key row (Esc, Tab, sticky Ctrl/Alt, arrows, ⇧Tab, ^C…). It also has a keys-only pad mode that hides the phone keyboard, and a compose box for dictating or pasting prompts.
- **Protocol** (`packages/protocol`) contains the shared message types.

The PTY's size follows whoever typed last (the laptop or the phone), like tmux's `window-size latest`.

## Auth (Jupyter-style)

- The printed link carries `?token=…`. Opening it sets an HttpOnly cookie for that session and redirects to the bare URL, so the token disappears from the address bar.
- Opening the bare URL without the cookie shows a login page that accepts the token or your password.
- `tui2web set-password` stores an scrypt hash in `~/.tui2web/config.json`. Only the hash is sent to the relay.
- Login is rate limited per session. Viewer WebSockets require a same-origin `Origin` header.

## Development

Requires Node 23.6+ (the TypeScript sources run directly via Node's type stripping).

```
npm install
npm run build            # build the web viewer into packages/web/dist
npm run relay            # relay on :8787  (PORT, HOST, PUBLIC_URL env vars)
node packages/cli/src/index.ts bash     # in another terminal
node scripts/e2e.mjs     # end-to-end test against the running relay
node scripts/restart.mjs # session survives a relay restart (starts its own relay)
```

To test on your phone over Wi-Fi, run the relay with `PUBLIC_URL=http://<your-LAN-ip>:8787`.

CLI options: `--relay <url>` (or `TUI2WEB_RELAY`), `--no-password`, `--no-qr`.

## Running the relay in Docker

```
docker build -t tui2web-relay .
docker run -p 8787:8787 -e PUBLIC_URL=https://tui2web.com tui2web-relay
# or: PUBLIC_URL=https://tui2web.com docker compose up -d
```

The public relay runs on Canine (project `tui2web`, `production` cluster) at https://tui2web.oncanine.run. It must stay at **1 replica**, because sessions live in memory. `PUBLIC_URL` is set as a project env var.

Put it behind something that terminates TLS (Caddy, Fly.io, a load balancer) and forwards WebSockets. `/healthz` reports session count and memory.

## Capacity (single instance)

Measured with `scripts/loadtest.mjs` (one agent and one viewer per session, Apple Silicon, localhost):

| | per session | 1 GB of RAM holds |
|---|---|---|
| fresh / idle session | ~0.2 MB | ~5,000 |
| long session (1,000-line scrollback full) | ~2.2 MB | ~450 |

One core handles ~2,000 sessions streaming Claude-style output at the same time (p50 42 ms). It saturates around 3,000 (p50 264 ms). Memory runs out before CPU does. Sessions live in memory. If the relay restarts or is redeployed, each CLI re-registers its session under the same id and token and repaints the screen from its own copy, so printed links and phone logins keep working. Phones wait up to 3 minutes for this to happen.

## Status

Milestone 1 (works end-to-end locally) is done. Next: mobile polish on real devices, then deploying to tui2web.com (TLS, which also turns on `Secure` cookies).
