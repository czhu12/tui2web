import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type * as NodePty from '@lydell/node-pty';

const require = createRequire(import.meta.url);

/**
 * node-pty's `spawn-helper` has at times been installed without its execute
 * bit, which makes every spawn fail with "posix_spawnp failed". Repair it
 * before loading the module. (@lydell/node-pty ships prebuilt binaries for
 * every platform in per-platform packages, so no install scripts are needed.)
 */
function ensureSpawnHelperExecutable() {
  if (process.platform === 'win32') return;
  const target = `${process.platform}-${process.arch}`;
  try {
    const root = dirname(require.resolve(`@lydell/node-pty-${target}/package.json`));
    const helper = join(root, 'prebuilds', target, 'spawn-helper');
    const { mode } = statSync(helper);
    if ((mode & 0o111) === 0) chmodSync(helper, (mode & 0o777) | 0o755);
  } catch {
    // Not present or not writable; node-pty will report a real problem itself.
  }
}

ensureSpawnHelperExecutable();
export const pty: typeof NodePty = require('@lydell/node-pty');
