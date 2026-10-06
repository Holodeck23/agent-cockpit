import { describe, expect, it } from 'vitest'
import { extractPathHelper, fallbackDirs, mergePath, resolveAppPath, systemPath } from '../electron/shell-path.ts'

describe('extractPathHelper', () => {
  it('reads PATH without evaluating the emitted shell code', () => {
    const output = 'PATH="/usr/local/bin:/usr/bin:/bin"; export PATH;\n'
    expect(extractPathHelper(output)).toBe('/usr/local/bin:/usr/bin:/bin')
  })

  it('returns undefined when the assignment is missing or empty', () => {
    expect(extractPathHelper('no assignment here')).toBeUndefined()
    expect(extractPathHelper('PATH=""; export PATH;')).toBeUndefined()
  })
})

describe('mergePath', () => {
  it('puts preferred entries first and drops duplicates and empties', () => {
    expect(mergePath('/usr/bin:/bin::/opt/homebrew/bin', ['/opt/homebrew/bin', '/Users/me/.npm-global/bin'])).toBe(
      '/opt/homebrew/bin:/Users/me/.npm-global/bin:/usr/bin:/bin',
    )
  })

  it('handles an unset PATH', () => {
    expect(mergePath(undefined, ['/a', '/b'])).toBe('/a:/b')
  })
})

describe('systemPath', () => {
  it('reads PATH directly from macOS path_helper', () => {
    const path = systemPath()
    expect(path).toBeDefined()
    expect(path?.split(':')).toContain('/usr/bin')
  })

  it('returns undefined when path_helper does not exist', () => {
    expect(systemPath('/nonexistent/path-helper', 1000)).toBeUndefined()
  })
})

describe('resolveAppPath', () => {
  it('searches COCKPIT_AGENT_PATH and common installs before the system PATH', () => {
    const env = { PATH: '/usr/bin', HOME: '/Users/me', COCKPIT_AGENT_PATH: '/tmp/agents::/opt/agents' }
    expect(resolveAppPath(env, () => '/system/bin:/usr/bin')).toEqual({
      path: '/tmp/agents:/opt/agents:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/Users/me/.local/bin:/Users/me/.npm-global/bin:/Users/me/.bun/bin:/Users/me/.volta/bin:/Users/me/.cargo/bin:/Users/me/.asdf/shims:/Users/me/.local/share/mise/shims:/Users/me/Library/pnpm:/system/bin:/usr/bin',
      source: 'system',
    })
  })

  it('keeps the current PATH after known install folders', () => {
    expect(resolveAppPath({ PATH: '/custom/bin:/usr/bin', HOME: '/Users/me' }, () => '/usr/bin').path).toContain(
      '/Users/me/.npm-global/bin:/Users/me/.bun/bin',
    )
    expect(resolveAppPath({ PATH: '/custom/bin:/usr/bin', HOME: '/Users/me' }, () => '/usr/bin')).toEqual({
      path: '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/Users/me/.local/bin:/Users/me/.npm-global/bin:/Users/me/.bun/bin:/Users/me/.volta/bin:/Users/me/.cargo/bin:/Users/me/.asdf/shims:/Users/me/.local/share/mise/shims:/Users/me/Library/pnpm:/usr/bin:/custom/bin',
      source: 'system',
    })
  })

  it('puts the agent path ahead of fallback folders when path_helper is unavailable', () => {
    const { path, source } = resolveAppPath({ HOME: '/Users/me', COCKPIT_AGENT_PATH: '/tmp/agents' }, () => undefined)
    expect(source).toBe('fallback')
    expect(path.split(':')[0]).toBe('/tmp/agents')
  })
})

describe('fallbackDirs', () => {
  it('covers Homebrew and user-level npm installs', () => {
    expect(fallbackDirs('/Users/me')).toEqual(expect.arrayContaining([
      '/opt/homebrew/bin', '/Users/me/.npm-global/bin', '/Users/me/.volta/bin', '/Users/me/.asdf/shims',
    ]))
  })
})
