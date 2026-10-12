import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { launchAntigravity } from '../../server/agents/antigravity/launch.ts'
import type { AgentCapabilities } from '../../server/agents/capabilities/types.ts'
import type { NormalizedEvent } from '../../server/agents/types.ts'

// u03-1: in the capability-checked path (the production path, manager.ts:335) spawnAntigravity runs
// inside the onFulfilled callback of `ready`. The `.then(onFulfilled, onRejected)` second argument only
// handles a rejection from check(), not a throw from onFulfilled. If spawnAntigravity throws (mkdirSync of
// the images folder: ENOSPC/EACCES/ENOTDIR), `ready` rejects with no handler, `ended` stays false, no
// error/result/exit event is emitted, alive() stays true and later sends are queued forever.
// CORRECT behaviour: the turn ends with an error + failed result + exit, the session reports not alive,
// later sends are not swallowed, close() resolves, and nothing rejects unhandled.
describe('u03-1: a synchronous throw while starting a checked Antigravity launch must end the turn', () => {
  it('reports the failure, ends the turn and leaks no unhandled rejection when the images folder cannot be created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-audit-u03-1-'))
    const exe = join(dir, 'agy-resolved')
    writeFileSync(exe, '#!/bin/sh\nwhile IFS= read -r line; do :; done\n')
    chmodSync(exe, 0o755)
    // A regular file where a directory is needed: mkdirSync(<file>/images, { recursive: true }) throws ENOTDIR.
    const blocker = join(dir, 'not-a-directory')
    writeFileSync(blocker, 'x')
    const imagesDir = join(blocker, 'images')

    const caps: AgentCapabilities = {
      agent: 'antigravity', context: 'default', settings: {}, auth: { state: 'signed_in' }, models: { state: 'not_checked' },
      executable: { state: 'found', identity: { command: 'agy', path: exe, realpath: exe, fingerprint: 'f', version: '1.3.1' } },
    }

    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      const events: NormalizedEvent[] = []
      const session = launchAntigravity({ cwd: dir, imagesDir }, (e) => events.push(e), { check: async () => caps })
      session.send('hello')

      // Let the check resolve, the launch attempt run, and Node surface any unhandled rejection.
      await new Promise((resolve) => setTimeout(resolve, 300))

      expect(rejections.map((r) => (r instanceof Error ? `${(r as NodeJS.ErrnoException).code ?? r.name}: ${r.message}` : String(r)))).toEqual([])
      expect(events.some((e) => e.kind === 'error')).toBe(true)
      expect(events).toContainEqual({ kind: 'result', ok: false })
      expect(events.some((e) => e.kind === 'exit')).toBe(true)
      expect(session.alive()).toBe(false)

      // A later message is not swallowed into a queue that is never delivered.
      const before = events.length
      session.send('anybody there?')
      expect(events.length).toBeGreaterThan(before)

      await expect(session.close()).resolves.toBeUndefined()
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})
