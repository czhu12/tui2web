// How tests launch the CLI. Defaults to the TypeScript source on the current
// Node; CI points these at the compiled dist/ and an older Node to check
// compatibility (TUI2WEB_CLI_NODE, TUI2WEB_CLI_ENTRY).
export const CLI_NODE = process.env.TUI2WEB_CLI_NODE || process.execPath;
export const CLI_ENTRY = process.env.TUI2WEB_CLI_ENTRY || 'packages/cli/src/index.ts';

/**
 * With --no-wait the CLI connects in the background, so its link is printed
 * before the relay has the session. Resolves once the link works.
 */
export async function whenLive(url, ms = 10000) {
  const start = Date.now();
  while ((await fetch(url, { redirect: 'manual' }).then((r) => r.status, () => 0)) !== 303) {
    if (Date.now() - start > ms) throw new Error(`link never went live: ${url.replace(/token=.*/, 'token=…')}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
