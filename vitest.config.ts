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
    // The suite itself launches many CLI stand-ins. Capping file workers prevents those child
    // processes from starving one another and crossing their explicit 5 s protocol deadlines.
    maxWorkers: 4,
    // Several integration tests launch real child processes. Under the full 295-file run, host
    // scheduling can consume most of Vitest's 5 s default even though the same tests finish when
    // isolated. Keep hangs bounded, but leave enough room for a loaded release machine.
    testTimeout: 10_000,
  },
})
