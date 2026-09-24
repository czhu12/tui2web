# Running your own relay

By default, `tui2web` sends your session through the public relay at `tui2web.com`. The relay passes your terminal between your computer and your phone, and it can see what's in the session. If you'd rather not trust it, run your own. It's one command, and your phone can reach it from anywhere through Cloudflare.

```
your computer ──▶ your relay ◀── Cloudflare Tunnel ◀── your phone
 tui2web claude   tui2web relay   (https://…)
```

## 1. Start a relay

The relay ships with the CLI:

```
npm install -g tui2web
tui2web relay
```

It listens on port 8787 and needs no configuration. Session links use whatever address people reach it at, including a Cloudflare hostname.

| Option | Default | |
|---|---|---|
| `--port <n>` | `8787` | Port to listen on |
| `--host <addr>` | all interfaces | Interface to bind, e.g. `127.0.0.1` to accept local connections only (fine behind a tunnel) |
| `--public-url <url>` | taken from each request | Fix the base URL used in session links |

Prefer Docker? `docker build -t tui2web-relay https://github.com/czhu12/tui2web.git`, then `docker run -p 8787:8787 tui2web-relay`.

To try it on your computer first:

```
tui2web --relay http://localhost:8787 bash
```

## 2. Make it reachable from your phone

Pick one option.

### Option A: Cloudflare quick tunnel (no account, one minute)

Install [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`brew install cloudflared` on macOS), then run it next to the relay:

```
cloudflared tunnel --url http://localhost:8787
```

It prints a URL like `https://random-words-here.trycloudflare.com`. Use it as your relay:

```
tui2web --relay https://random-words-here.trycloudflare.com claude
```

The URL changes every time `cloudflared` restarts, and Cloudflare offers quick tunnels for testing, without uptime guarantees. For something permanent, use option B.

### Option B: Named Cloudflare tunnel on your own domain

This needs a free Cloudflare account and a domain whose DNS is on Cloudflare. You get a stable address like `https://relay.example.com`.

```
cloudflared tunnel login
cloudflared tunnel create tui2web
cloudflared tunnel route dns tui2web relay.example.com
```

`tunnel create` prints the path of a credentials file. Put this in `~/.cloudflared/config.yml`:

```yaml
tunnel: tui2web
credentials-file: /Users/you/.cloudflared/<TUNNEL-ID>.json

ingress:
  - hostname: relay.example.com
    service: http://localhost:8787
  - service: http_status:404
```

Start it with `cloudflared tunnel run tui2web`. To keep it running across reboots, install it as a service with `sudo cloudflared service install`.

### Option C: A server, with Docker and a tunnel token

To run the relay on a server instead of your laptop, create a tunnel in the Cloudflare dashboard (Zero Trust → Networks → Tunnels). Give it a public hostname whose service is `http://relay:8787`, and copy its token. Then:

```yaml
# docker-compose.yml
services:
  relay:
    build: https://github.com/czhu12/tui2web.git
    restart: unless-stopped
  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${TUNNEL_TOKEN}
    restart: unless-stopped
```

```
TUNNEL_TOKEN=... docker compose up -d
```

No ports are opened on the server. `cloudflared` connects out to Cloudflare, like the tui2web CLI does.

## 3. Point the CLI at your relay

Pass it each time:

```
tui2web --relay https://relay.example.com claude
```

Or set it once. The CLI checks, in order: `--relay`, then `$TUI2WEB_RELAY`, then `"relay"` in `~/.tui2web/config.json`.

```json
{ "relay": "https://relay.example.com" }
```

Everything else works the same: `tui2web set-password`, the Ctrl+\ link hotkey, `tui2web ls`, and sessions surviving relay restarts.

## Notes

- **Cloudflare can see your traffic too.** A Cloudflare tunnel decrypts traffic at Cloudflare's edge, so you're trusting Cloudflare instead of tui2web.com. For a path where nobody in the middle can read it, reach your relay over [Tailscale](https://tailscale.com) instead: run `tui2web relay` on your computer, put your phone on the same tailnet, and use `--relay http://your-computer:8787`. WireGuard encrypts it end to end.
- **Who can use your relay.** Anyone who knows its URL can start sessions on it, which uses your bandwidth. They can't see or control your sessions, because those still need the link's token or your password.
- **WebSockets.** Cloudflare passes them through. It closes connections that are idle for about 100 seconds, and the relay pings every 30 seconds to prevent that.
- **Health check.** `GET /healthz` returns `ok` and the number of active sessions.
