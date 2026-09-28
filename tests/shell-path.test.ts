import { describe, expect, it } from 'vitest'
import { extractMarkedPath, fallbackDirs, loginShellPath, mergePath } from '../electron/shell-path.ts'

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
    const path = loginShellPath('/bin/zsh')
    expect(path).toBeDefined()
    expect(path?.split(':')).toContain('/usr/bin')
  })

  it('returns undefined when the shell does not exist', () => {
    expect(loginShellPath('/nonexistent/shell', 1000)).toBeUndefined()
  })
})

describe('fallbackDirs', () => {
  it('covers Homebrew and user-level npm installs', () => {
    expect(fallbackDirs('/Users/me')).toEqual(expect.arrayContaining(['/opt/homebrew/bin', '/Users/me/.npm-global/bin']))
  })
})
