import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts, whose root is web/.
// globalSetup gives the run one short temp folder (TMPDIR) that is removed at the end, so the
// hundreds of mkdtemp dirs the tests make never reach the real temp dir.
export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/setup/global-temp.ts'],
    // Integration files launch several CLI stand-ins and policy runners of their own. Run files
    // serially so competing workers do not consume their real 2–5 s startup/timeout budgets.
    // Keep the assertions and provider deadlines intact; CLI callers can opt into more workers.
    maxWorkers: 1,
    // Several integration tests launch real child processes. Under the full 295-file run, host
    // scheduling can consume most of Vitest's 5 s default even though the same tests finish when
    // isolated. Keep hangs bounded, but leave enough room for a loaded release machine.
    testTimeout: 10_000,
  },
})
