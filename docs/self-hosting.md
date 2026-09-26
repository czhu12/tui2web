# Running your own relay

By default, `tui2web` sends your session through the public relay at `tui2web.com`. The relay passes your terminal between your computer and your phone, and it can see what's in the session. If you'd rather not trust it, keep the session on your own devices with Tailscale (one flag), or run a relay yourself.

## Most private: Tailscale

With [Tailscale](https://tailscale.com), your phone talks to your computer directly over an encrypted WireGuard connection. Nothing is exposed to the internet: there's no public relay and no open ports.

1. Install Tailscale on your computer and your phone, and sign both into the same account.
2. Run:

```
tui2web --tailscale claude
```

That's it: there's no separate relay to start. The session runs its own relay inside the `tui2web` process, listening only on your computer's Tailscale addresses. The link uses your computer's MagicDNS name, like `http://your-computer.tailnet-name.ts.net:8787/session/…`, or its `100.x.y.z` address if MagicDNS is off.

If Tailscale is off or signed out when you start, your command runs anyway, without a link. Turn Tailscale on, then press Ctrl+\ and `c`: the session starts its relay and shows the link. It never uses the public relay instead.

To make it the default, so plain `tui2web claude` stays on your tailnet:

```
tui2web use tailscale
```

(`tui2web use public` switches back. `--relay` still overrides it for one session.)

Each session gets its own relay on the next free port from 8787 (8787, 8788, …), so sessions are independent: quitting or killing one doesn't affect the others. The relay stops when its session ends.

Prefer one long-running relay that sessions connect to? `tui2web relay --tailscale` starts one on your Tailscale addresses and prints the `--relay` URL to use.

Why it's the most private option:

- Traffic is encrypted end to end between your devices. When Tailscale can't connect them directly it routes through its relay servers, but those only forward encrypted packets.
- Only devices on your tailnet can reach the relay, so nobody else can find it or start sessions on it. It doesn't listen on your Wi-Fi or LAN address at all.
- Tailscale's coordination servers see which devices you have and when they're online, never your terminal.

The trade-offs: your phone needs the Tailscale app connected, it only works for your own devices, and the link is `http://`. WireGuard still encrypts it, but the browser doesn't treat it as HTTPS.

## Running a relay yourself

The relay ships with the CLI:

```
npm install -g tui2web
tui2web relay
```

It listens on port 8787 and needs no configuration. Session links use whatever address people reach it at, including behind a reverse proxy.

| Option | Default | |
|---|---|---|
| `--port <n>` | `8787` | Port to listen on |
| `--host <addr>` | all interfaces | Interface to bind, e.g. `127.0.0.1` to accept local connections only (fine behind a reverse proxy) |
| `--public-url <url>` | taken from each request | Fix the base URL used in session links |
| `--tailscale` | off | Listen on your Tailscale addresses only (see above) |

To try it on your computer first:

```
tui2web --relay http://localhost:8787 bash
```

On the same Wi-Fi, your phone can reach it at your computer's LAN address, e.g. `tui2web --relay http://192.168.1.20:8787 claude`.

### On a server, with Docker

```
docker build -t tui2web-relay https://github.com/czhu12/tui2web.git
docker run -p 8787:8787 -e PUBLIC_URL=https://relay.example.com tui2web-relay
```

Put it behind something that terminates TLS and forwards WebSockets (Caddy, nginx, a load balancer). Run a single instance: sessions live in memory.

### Point the CLI at it

Pass it each time:

```
tui2web --relay https://relay.example.com claude
```

Or set it once with `tui2web use https://relay.example.com`. The CLI checks, in order: `--relay` (or `--tailscale`), then `$TUI2WEB_RELAY`, then the saved choice in `~/.tui2web/config.json`.

Everything else works the same: `tui2web set-password`, the Ctrl+\ link hotkey, `tui2web ls`, and sessions surviving relay restarts.

## Notes

- **Who can use your relay.** Anyone who can reach a relay can start sessions on it, which uses your bandwidth. They can't see or control your sessions, because those still need the link's token or your password. With Tailscale, only your own devices can reach it.
- **WebSockets.** Proxies in front of the relay must pass WebSockets through. The relay pings every 30 seconds, which keeps connections alive through proxies with idle timeouts.
- **Health check.** `GET /healthz` returns `ok` and the number of active sessions.
