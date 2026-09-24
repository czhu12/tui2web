import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type * as NodePty from 'node-pty';

const require = createRequire(import.meta.url);

/**
 * node-pty's prebuilt `spawn-helper` is sometimes installed without its execute
 * bit, which makes every spawn fail with "posix_spawnp failed". Repair it before
 * loading the module.
 */
function ensureSpawnHelperExecutable() {
  if (process.platform === 'win32') return;
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const dir of [join('build', 'Release'), join('prebuilds', `${process.platform}-${process.arch}`)]) {
    const helper = join(root, dir, 'spawn-helper');
    try {
      const { mode } = statSync(helper);
      if ((mode & 0o111) === 0) chmodSync(helper, (mode & 0o777) | 0o755);
    } catch {
      // Not present in this layout; node-pty will report a real problem itself.
    }
  }
}

ensureSpawnHelperExecutable();
export const pty: typeof NodePty = require('node-pty');
