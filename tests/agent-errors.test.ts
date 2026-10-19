import { expect, it } from 'vitest'
import { failureWords } from '../web/src/agent-errors.ts'

it.each(['Cockpit MCP bridge did not authenticate within 15000 ms',
  'Codex could not authenticate Cockpit’s bridge. Your message was not delivered.',
  "Codex could not authenticate Cockpit's bridge. Your message was not delivered.",
  'Cockpit bridge did not authenticate in time', 'Cockpit MCP grant was revoked before authentication'])(
  'identifies a scoped bridge failure without asking for provider sign-in: %s', (message) => {
  expect(failureWords(message).title).toBe('Cockpit tools could not connect')
})

it.each(['Claude is not signed in', 'Codex authentication failed: 401', 'Invalid API key for the selected agent'])(
  'retains actual provider sign-in failures: %s', (message) => {
  expect(failureWords(message).title).toBe('The agent is not signed in')
})
