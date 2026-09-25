import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Where this machine can be reached on the tailnet. */
export type TailscaleAddress = {
  /** Tailscale IPv4 address, e.g. 100.101.102.103. */
  ip: string;
  /** Every Tailscale address (IPv4 and IPv6) to bind: the MagicDNS name resolves to all of them. */
  ips: string[];
  /** Host for links: the MagicDNS name (e.g. my-mac.tailnet.ts.net), or `ip` when MagicDNS is off. */
  host: string;
};

type Status = {
  BackendState?: string;
  Self?: { DNSName?: string; TailscaleIPs?: string[] };
  CurrentTailnet?: { MagicDNSEnabled?: boolean } | null;
};

// The macOS app bundles its CLI here without putting it on PATH.
const MAC_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

function candidates(): string[] {
  const override = process.env.TUI2WEB_TAILSCALE_BIN;
  if (override) return [override];
  return process.platform === 'darwin' && existsSync(MAC_APP_CLI) ? ['tailscale', MAC_APP_CLI] : ['tailscale'];
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }));
      else resolve(String(stdout));
    });
  });
}

/** Reads this machine's tailnet address, or throws an error that says how to fix it. */
export async function tailscaleAddress(): Promise<TailscaleAddress> {
  let output: string | null = null;
  let failure: (Error & { code?: unknown; stderr?: string }) | null = null;
  for (const bin of candidates()) {
    try {
      output = await run(bin, ['status', '--json']);
      break;
    } catch (err) {
      const e = err as Error & { code?: unknown; stderr?: string };
      // Not found: try the next place. Anything else: Tailscale is there but unhappy.
      if (e.code === 'ENOENT') continue;
      failure = e;
      break;
    }
  }
  if (output === null) {
    if (!failure) throw new Error('Tailscale is not installed. Get it at https://tailscale.com/download, then sign in on this computer and your phone.');
    // tailscale status exits non-zero when the daemon isn't running, but may still print JSON.
    const detail = (failure.stderr || failure.message).trim().split('\n')[0];
    throw new Error(`could not read Tailscale status (${detail}). Is Tailscale running? Try: tailscale up`);
  }

  let status: Status;
  try {
    status = JSON.parse(output);
  } catch {
    throw new Error('could not parse `tailscale status --json` output');
  }

  const state = status.BackendState;
  if (state === 'NeedsLogin') throw new Error('Tailscale is not signed in. Run: tailscale up');
  if (state !== 'Running') throw new Error(`Tailscale is ${(state ?? 'not running').toLowerCase()}. Start it (tailscale up, or open the Tailscale app) and try again.`);

  const ips = status.Self?.TailscaleIPs ?? [];
  const ip = ips.find((a) => a.includes('.'));
  if (!ip) throw new Error('Tailscale is running but this computer has no Tailscale IPv4 address.');
  const dnsName = status.Self?.DNSName?.replace(/\.$/, '');
  const host = status.CurrentTailnet?.MagicDNSEnabled && dnsName ? dnsName : ip;
  return { ip, ips, host };
}
