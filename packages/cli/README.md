# tui2web

Open any terminal program on your phone. It's built with Claude Code in mind.

```
npm install -g tui2web
tui2web claude --continue
```

Shell aliases and functions work too: with `alias claw="claude --dangerously-skip-permissions"`, `tui2web claw` runs through your shell so the alias is found.

tui2web prints a link and a QR code. Open it on your phone to see the same terminal and type into it. Your laptop terminal keeps working normally, and both sides stay in sync.

## Features

- **Works anywhere.** Your computer dials out to the relay, so it works behind NAT or firewalls with no port forwarding.
- **Built for phones.** There's a key row for Esc, Tab, Ctrl, arrows, ⇧Tab and ^C. A keys-only pad hides the phone keyboard for answering prompts.
- **Survives network drops and relay restarts.** The session reconnects and repaints itself, and your link keeps working.

## Security

The printed link contains a secret token. Opening it logs that browser in, then removes the token from the address bar. **Anyone with the link can control your terminal**, so treat it like a password.

To open sessions without the link (for example, by typing the URL on your phone), set a password:

```
tui2web set-password
```

Only a salted scrypt hash is stored in `~/.tui2web/config.json` and sent to the relay.

## Options

```
tui2web [options] <command> [args...]

--relay <url>    Relay server (default: $TUI2WEB_RELAY or the public relay)
--no-password    Only accept the link's token for this session
--no-qr          Don't print a QR code
--no-wait        Start the command right away instead of waiting for Enter
--hotkey <key>   Key that shows the link again (default: ctrl-\; e.g. ctrl-^, ctrl-g, none)
```

## Getting the link back

Full-screen programs clear the screen when they start, so tui2web keeps the link and QR code up until you press **Enter**. Ctrl+C cancels.

Once the program is running, there are two ways to get the link again:

- Press **Ctrl+\\** to show the link and QR code over the program. Press any key to go back. The program keeps running meanwhile.
- Run **`tui2web ls`** in another terminal to list your running sessions and their links.

The link is also printed again when the session ends.

You can self-host the relay. See the [repository](https://github.com/czhu12/tui2web).

Requires Node.js 16 or newer. Runs on macOS, Linux and Windows (x64 and arm64).
