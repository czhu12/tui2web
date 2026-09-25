// Bundles the built web viewer and landing page into dist/web, so the relay
// that ships with the CLI (`tui2web relay`) can serve them.
import { cpSync, existsSync } from 'node:fs';

const from = new URL('../../web/dist/', import.meta.url);
if (!existsSync(new URL('index.html', from))) {
  console.error('packages/web/dist is missing. Run `npm run build:web` (or `npm run build` at the repo root) first.');
  process.exit(1);
}
// The promo video would add ~2 MB to the npm package; the landing page loads
// it from tui2web.com instead.
cpSync(from, new URL('../dist/web/', import.meta.url), {
  recursive: true,
  filter: (src) => !/[\\/]promo([\\/]|$)/.test(src),
});
