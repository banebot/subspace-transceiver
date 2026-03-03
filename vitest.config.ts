import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Unit tests only (no integration) by default
    // Integration tests are in store.test.ts — run with INTEGRATION=1 vitest
    testTimeout: 10_000,
  },
})
