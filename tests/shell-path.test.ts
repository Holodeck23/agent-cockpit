import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { extractMarkedPath, fallbackDirs, loginShellPath, mergePath, resolveAppPath } from '../electron/shell-path.ts'

describe('extractMarkedPath', () => {
  it('ignores profile banners around the marked PATH', () => {
    const output = 'Welcome back!\n__COCKPIT_PATH__/opt/homebrew/bin:/usr/bin__COCKPIT_PATH__\nlast login'
    expect(extractMarkedPath(output)).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('returns undefined when the markers are missing or empty', () => {
    expect(extractMarkedPath('no markers here')).toBeUndefined()
    expect(extractMarkedPath('__COCKPIT_PATH____COCKPIT_PATH__')).toBeUndefined()
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

describe('loginShellPath', () => {
  it('reads PATH from a real login shell', () => {
    // zsh on a Mac; whichever login shell exists elsewhere.
    const shell = ['/bin/zsh', '/bin/bash', '/usr/bin/bash'].find((candidate) => existsSync(candidate))!
    const path = loginShellPath(shell)
    expect(path).toBeDefined()
    expect(path?.split(':')).toContain('/usr/bin')
  })

  it('returns undefined when the shell does not exist', () => {
    expect(loginShellPath('/nonexistent/shell', 1000)).toBeUndefined()
  })
})

describe('resolveAppPath', () => {
  it('searches COCKPIT_AGENT_PATH before the login shell PATH', () => {
    const env = { PATH: '/usr/bin', COCKPIT_AGENT_PATH: '/tmp/agents::/opt/agents' }
    expect(resolveAppPath(env, () => '/opt/homebrew/bin:/usr/bin', '/Users/u')).toEqual({
      path: '/tmp/agents:/opt/agents:/opt/homebrew/bin:/usr/bin:/Users/u/.local/bin',
      source: 'shell',
    })
  })

  it('keeps the shell order when no agent path is set', () => {
    expect(resolveAppPath({ PATH: '/usr/bin' }, () => '/opt/homebrew/bin', '/Users/u').path).toBe('/opt/homebrew/bin:/Users/u/.local/bin:/usr/bin')
  })

  it('keeps ~/.local/bin where the shell already put it', () => {
    expect(resolveAppPath({ PATH: '/usr/bin' }, () => '/Users/u/.local/bin:/opt/homebrew/bin', '/Users/u').path).toBe('/Users/u/.local/bin:/opt/homebrew/bin:/usr/bin')
  })

  it('puts the agent path ahead of the fallback folders when the shell cannot be asked', () => {
    const { path, source } = resolveAppPath({ COCKPIT_AGENT_PATH: '/tmp/agents' }, () => undefined)
    expect(source).toBe('fallback')
    expect(path.split(':')[0]).toBe('/tmp/agents')
  })
})

describe('fallbackDirs', () => {
  it('covers Homebrew and user-level npm installs', () => {
    expect(fallbackDirs('/Users/me')).toEqual(expect.arrayContaining(['/opt/homebrew/bin', '/Users/me/.npm-global/bin']))
  })
})
