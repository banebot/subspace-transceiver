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
    // Limit parallel workers: each test file spawns 2-4 daemon processes.
    // Cap at 2 workers — reduces daemon count from 20-30 to 4-8 for more reliable
    // GossipSub delivery, latency tests, and rate-limit windows.
    maxWorkers: 2,
    // Run test files one at a time to prevent port conflicts and resource exhaustion.
    fileParallelism: false,
    // Serial execution within each file — no shared state between tests.
    maxConcurrency: 1,
    // Show test names as they run (useful for long-running tests)
    reporters: ['verbose'],
    // Increase memory ceiling for the test runner itself
    // (daemon child processes are separate, this is just the test runner)
    env: {
      // Default testability knobs — can be overridden per-suite
      SUBSPACE_MANIFEST_INTERVAL_MS: '5000',
      SUBSPACE_GC_INTERVAL_MS: '2000',
      // SUBSPACE_BOOTSTRAP_ADDRS='' is set per-agent in harness.ts to avoid
      // polluting the global bootstrap network. Relay addresses are kept
      // enabled so PSK nodes can connect to relay servers for NAT traversal.
      // Note: SUBSPACE_MAX_CHUNKS_PER_PEER is intentionally NOT set here so
      // the rate-limiting test's per-suite extraEnv can override the daemon
      // default cleanly. The daemon default is raised to 10000 in config.ts
      // so test suites never accidentally hit the cap.
    },
  },
})
