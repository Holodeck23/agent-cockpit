import { expect, it } from 'vitest'
import { failureWords } from '../web/src/agent-errors.ts'

it('keeps Cockpit bridge authentication failure distinct from agent sign-in', () => {
  expect(failureWords('Cockpit MCP bridge did not authenticate within 15000 ms').title).toBe('Cockpit tools could not connect')
  expect(failureWords('Claude is not signed in').title).toBe('The agent is not signed in')
})
