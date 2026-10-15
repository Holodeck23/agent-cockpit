import { expect, it } from 'vitest'
import { createMcpSessions } from '../server/mcp/sessions.ts'

const grant = { threadId: 'thread', projectPath: '/project', cwd: '/project' }

it('holds readiness for the scoped authenticated host round trip and revokes a waiting grant', async () => {
  const sessions = createMcpSessions()
  const token = sessions.issue(grant)
  let ready = false
  const waiting = sessions.waitAuthenticated(token, 100).then(() => { ready = true })
  await Promise.resolve()
  expect(ready).toBe(false)
  sessions.markAuthenticated('wrong-token')
  expect(ready).toBe(false)
  sessions.markAuthenticated(token)
  await waiting
  expect(ready).toBe(true)
  await expect(sessions.waitAuthenticated(token)).resolves.toBeUndefined()

  const revoked = sessions.issue(grant)
  const blocked = sessions.waitAuthenticated(revoked, 100)
  sessions.revoke(revoked)
  await expect(blocked).rejects.toThrow(/revoked/)
  await expect(sessions.waitAuthenticated(revoked)).rejects.toThrow(/expired/)
})

it('times out when the bridge never authenticates', async () => {
  const sessions = createMcpSessions()
  await expect(sessions.waitAuthenticated(sessions.issue(grant), 5)).rejects.toThrow(/did not authenticate/)
})
