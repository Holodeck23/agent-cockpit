import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startServer } from '../server/start.ts'
import type { Launcher } from '../server/threads/manager.ts'

describe('DELETE /api/threads/:id', () => {
  it('deletes through the page’s JSON request and refuses a bare one', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'cockpit-delete-state-'))
    const project = mkdtempSync(join(tmpdir(), 'cockpit-delete-project-'))
    const launcher: Launcher = (_request, emit) => ({ agent: 'claude', alive: () => true, send() {}, respondApproval() {}, interrupt() {},
      close: async () => { emit({ kind: 'exit', code: 0 }) } })
    const server = await startServer({ port: 0, stateRoot, webDist: project, launchers: { claude: launcher, codex: launcher } })
    try {
      const created = await (await fetch(`${server.url}/api/threads`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath: project, text: 'hello', settings: { agent: 'claude' } }) })).json()
      const id = created.data.id as string
      expect(existsSync(join(stateRoot, 'threads', id))).toBe(true)
      // A request without a JSON content type could come from another site's form; the guard refuses it.
      expect((await fetch(`${server.url}/api/threads/${id}`, { method: 'DELETE' })).status).toBe(403)
      const deleted = await fetch(`${server.url}/api/threads/${id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect(deleted.status).toBe(200)
      expect(existsSync(join(stateRoot, 'threads', id))).toBe(false)
      expect((await fetch(`${server.url}/api/threads/${id}/events`)).status).toBe(404)
    } finally { await server.close() }
  })
})
