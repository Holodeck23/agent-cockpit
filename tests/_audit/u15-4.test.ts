import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCheckRunner } from '../../server/results/checks.ts'
import { createResultStore, RESULT_VERSION, type CheckRecord } from '../../server/results/store.ts'

// u15-4: looking up a check that is not live scanned every result file with store.get(), which
// throws StoreReadError for one damaged or newer file, so one bad file broke the lookup for all.

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'cockpit-u15-4-'))
  const state = join(base, 'state')
  mkdirSync(join(state, 'results'), { recursive: true })
  return { state, store: createResultStore(state) }
}

const record = (id: string): CheckRecord => ({
  id, runId: 'run-good', threadId: 't1', projectPath: '/p', operationId: 'op-1',
  definition: { command: 'true', cwd: '.', env: [], timeoutSec: 60, criterion: { kind: 'exit-zero' }, inputs: [] },
  inputHash: 'h', approval: { by: 'user', at: '2026-10-05T10:00:00.000Z' }, origin: 'host', phase: 'terminal', outcome: 'passed',
  preparedAt: '2026-10-05T10:00:00.000Z', endedAt: '2026-10-05T10:00:01.000Z',
})

describe('u15-4: one unreadable result file does not break a check lookup', () => {
  it('cancel() of a finished check still finds it beside a damaged file and a newer-version file', async () => {
    const { state, store } = setup()
    store.update('run-good', 't1', (f) => ({ ...f, checks: [record('chk-good')] }))
    writeFileSync(join(state, 'results', 'aaa-damaged.json'), '{oops')
    writeFileSync(join(state, 'results', 'aab-future.json'), JSON.stringify({ version: RESULT_VERSION + 1 }))
    const checks = createCheckRunner(store)
    await expect(checks.cancel('chk-good')).resolves.toMatchObject({ id: 'chk-good', outcome: 'passed' })
    await expect(checks.cancel('chk-nobody')).resolves.toBeUndefined()
  })
})
