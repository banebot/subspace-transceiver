import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // E2E tests spin up real daemon processes — they're inherently slow.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Each test file gets its own process — no shared state between files.
    pool: 'forks',
    // Serial execution — a laptop can't run 5+ daemon processes per test file
    // concurrently across multiple files without exhausting ports and memory.
    maxConcurrency: 1,
    // Show test names as they run (useful for long-running tests)
    reporter: 'verbose',
    // Increase memory ceiling for the test runner itself
    // (daemon child processes are separate, this is just the test runner)
    env: {
      // Default testability knobs — can be overridden per-suite
      SUBSPACE_MANIFEST_INTERVAL_MS: '5000',
      SUBSPACE_GC_INTERVAL_MS: '2000',
    },
  },
})
