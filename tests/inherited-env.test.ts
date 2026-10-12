import { describe, expect, it } from 'vitest'
import { inheritedEnv } from '../server/agents/inherited-env.ts'

describe('the environment Cockpit hands its children', () => {
  it('drops a Cockpit MCP address and token it inherited, and keeps the rest', () => {
    const env = inheritedEnv({ PATH: '/usr/bin', HOME: '/h', COCKPIT_MCP_URL: 'http://127.0.0.1:1', COCKPIT_MCP_TOKEN: 'outer-token' })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/h' })
  })
})
