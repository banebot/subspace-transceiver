#!/usr/bin/env node
/**
 * Binary entry point — compiled by `bun build --compile` into a standalone executable.
 *
 * When the compiled binary is spawned with `--_daemon` as its first argument,
 * it runs the daemon process directly (so the single binary is its own daemon).
 * Otherwise it runs the normal CLI.
 *
 * This file is intentionally NOT compiled by tsc (it lives outside src/).
 * It is only used as the bun compile entry point.
 */

if (process.argv[2] === '--_daemon') {
  // Remove the flag so the daemon's own arg parser doesn't see it
  process.argv.splice(2, 1)
  // Run daemon — bun bundles this import into the binary at compile time
  await import('../daemon/src/index.ts')
} else {
  await import('./src/index.ts')
}
