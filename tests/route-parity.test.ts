import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isRemoteRoute } from '../server/remote/guard.ts'
import { ROUTES } from '../server/remote/routes.ts'

// Every /api/threads and /api/git route must say whether the phone may use it (R5). The routes
// are found in the router's own code, so a new one fails here until it is put in ROUTES.
const source = (file: string): string => readFileSync(new URL(`../server/http/${file}`, import.meta.url), 'utf8')

function threadRoutes(): Set<string> {
  const router = source('router.ts')
  const section = router.slice(router.indexOf("if (parts[1] !== 'threads')"))
  const found = new Set<string>()
  for (const [, method] of section.matchAll(/parts\.length === 2 && method === '(\w+)'/g)) found.add(`${method} threads`)
  for (const [, word, method] of section.matchAll(/parts\[2\] === '(\w+)' && method === '(\w+)'/g)) found.add(`${method} threads/${word}`)
  for (const [, method] of section.matchAll(/method === '(\w+)' && !action/g)) found.add(`${method} threads/:id`)
  for (const [, method, action] of section.matchAll(/method === '(\w+)' && action === '(\w+)'/g)) found.add(`${method} threads/:id/${action}`)
  return found
}

function gitRoutes(): Set<string> {
  const found = new Set<string>()
  for (const line of source('git-routes.ts').split('\n')) {
    const method = /method === '(\w+)'/.exec(line)?.[1]
    if (/method === '\w+' && !action/.test(line)) found.add(`${method} git`)
    for (const [, action] of line.matchAll(/action === '(\w+)'/g)) found.add(`${method ?? 'POST'} git/${action}`)
  }
  return found
}

/** A classified route, named the way the scan names it: params after the action are dropped. */
const scanKey = (method: string, route: string): string => {
  const segments = route.split('/')
  const kept = segments[0] === 'threads' && segments[1] === ':id' ? segments.slice(0, 3) : segments.slice(0, 2)
  return `${method} ${kept.join('/')}`
}

describe('phone route classification (R5)', () => {
  const classified = new Set(ROUTES.filter((r) => /^(threads|git)\b/.test(r.route)).map((r) => scanKey(r.method, r.route)))

  it('classifies every /api/threads and /api/git route the router serves', () => {
    const served = [...threadRoutes(), ...gitRoutes()]
    expect(served.length).toBeGreaterThan(15)
    expect(served.filter((route) => !classified.has(route))).toEqual([])
  })

  it('names no route the router does not serve', () => {
    const served = new Set([...threadRoutes(), ...gitRoutes()])
    expect([...classified].filter((route) => !served.has(route))).toEqual([])
  })

  it('lets the phone answer questions, take back a waiting message and see conversation images', () => {
    expect(isRemoteRoute('POST', '/api/threads/t1/questions/q1')).toBe(true)
    expect(isRemoteRoute('POST', '/api/threads/t1/queued/m1/remove')).toBe(true)
    expect(isRemoteRoute('GET', '/api/threads/t1/images/abc.png')).toBe(true)
  })

  it('keeps desktop-only routes off the phone, and paths must match exactly', () => {
    expect(isRemoteRoute('POST', '/api/threads/t1/completed')).toBe(false)
    expect(isRemoteRoute('POST', '/api/threads/t1/agent')).toBe(false)
    // Capabilities name executable paths and sign-in state (W10.1).
    expect(isRemoteRoute('GET', '/api/agents/claude/capabilities')).toBe(false)
    expect(isRemoteRoute('POST', '/api/agents/claude/capabilities/refresh')).toBe(false)
    expect(isRemoteRoute('DELETE', '/api/threads/t1')).toBe(false)
    expect(isRemoteRoute('POST', '/api/git/switch')).toBe(false)
    expect(isRemoteRoute('GET', '/api/threads/t1/images/a/b.png')).toBe(false)
    expect(isRemoteRoute('POST', '/api/threads/t1/queued/m1/remove/x')).toBe(false)
    expect(isRemoteRoute('GET', '/api/threads/t1/questions/q1')).toBe(false)
  })
})
