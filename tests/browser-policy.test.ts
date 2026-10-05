import { describe, expect, it } from 'vitest'
import { addressToUrl, isAllowedRequest, isNavigable, pageKeyOk, partitionFor, validBounds } from '../electron/browser-policy.ts'

const COCKPIT = [4317, 4400]

describe('isAllowedRequest (H2 host policy on a browser partition)', () => {
  it('lets ordinary web and local dev traffic through', () => {
    for (const url of ['https://example.com/a', 'http://localhost:5173/', 'ws://localhost:5173/hmr', 'wss://example.com/s', 'blob:https://example.com/x', 'data:image/png;base64,AA']) {
      expect(isAllowedRequest(url, COCKPIT), url).toBe(true)
    }
  })
  it("refuses Cockpit's own listeners under every loopback spelling", () => {
    for (const url of ['http://127.0.0.1:4317/api/threads', 'http://localhost:4317/', 'http://[::1]:4317/x', 'http://0.0.0.0:4317/', 'http://127.1.2.3:4400/', 'ws://localhost:4317/events', 'http://LOCALHOST:4317/']) {
      expect(isAllowedRequest(url, COCKPIT), url).toBe(false)
    }
  })
  it('refuses privileged and local-file schemes', () => {
    for (const url of ['file:///etc/hosts', 'javascript:alert(1)', 'chrome://settings', 'devtools://devtools/x', 'about:config', 'ftp://example.com/', 'not a url']) {
      expect(isAllowedRequest(url, COCKPIT), url).toBe(false)
    }
  })
  it('also refuses *.localhost and IPv4-mapped IPv6, which Chromium sends to loopback', () => {
    expect(isAllowedRequest('http://evil.localhost:4317/', COCKPIT)).toBe(false)
    expect(isAllowedRequest('http://[::ffff:127.0.0.1]:4317/', COCKPIT)).toBe(false)
    expect(isAllowedRequest('http://localhost.:4317/', COCKPIT)).toBe(false)
  })
  it('does not treat a remote host on the same port as Cockpit', () => {
    expect(isAllowedRequest('https://example.com:4317/', COCKPIT)).toBe(true)
  })
})

describe('isNavigable (top-level page loads)', () => {
  it('allows http(s) only, and never Cockpit', () => {
    expect(isNavigable('https://example.com/', COCKPIT)).toBe(true)
    expect(isNavigable('http://localhost:3000/', COCKPIT)).toBe(true)
    expect(isNavigable('data:text/html,hi', COCKPIT)).toBe(false)
    expect(isNavigable('blob:https://example.com/x', COCKPIT)).toBe(false)
    expect(isNavigable('http://localhost:4317/', COCKPIT)).toBe(false)
  })
})

describe('addressToUrl (the address field)', () => {
  it('keeps full http(s) addresses and fills in a scheme', () => {
    expect(addressToUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(addressToUrl('example.com')).toBe('https://example.com/')
    expect(addressToUrl('localhost:3000/path')).toBe('http://localhost:3000/path')
    expect(addressToUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/')
    expect(addressToUrl('  docs.example.org/x  ')).toBe('https://docs.example.org/x')
  })
  it('refuses other schemes and text that is not an address', () => {
    expect(addressToUrl('javascript:alert(1)')).toBeUndefined()
    expect(addressToUrl('file:///etc/hosts')).toBeUndefined()
    expect(addressToUrl('two words')).toBeUndefined()
    expect(addressToUrl('')).toBeUndefined()
  })
})

describe('validBounds (geometry from the page)', () => {
  const content = { width: 1360, height: 860 }
  it('accepts a rectangle inside the window, each edge rounded to a whole pixel', () => {
    expect(validBounds({ x: 800.4, y: 90.6, width: 520.2, height: 700 }, content)).toEqual({ x: 800, y: 91, width: 521, height: 700 })
  })
  it('clips to the window and refuses junk or slivers', () => {
    expect(validBounds({ x: 1000, y: 100, width: 600, height: 900 }, content)).toEqual({ x: 1000, y: 100, width: 360, height: 760 })
    expect(validBounds({ x: Number.NaN, y: 0, width: 100, height: 100 }, content)).toBeUndefined()
    expect(validBounds({ x: 10, y: 10, width: 40, height: 400 }, content)).toBeUndefined()
    expect(validBounds({ x: 2000, y: 10, width: 400, height: 400 }, content)).toBeUndefined()
    expect(validBounds('nope', content)).toBeUndefined()
  })
})

describe('page keys and partitions', () => {
  it('accepts conversation and project keys only', () => {
    expect(pageKeyOk('thread:abc-123')).toBe(true)
    expect(pageKeyOk('project:/Users/me/app')).toBe(true)
    expect(pageKeyOk('thread:../x')).toBe(false)
    expect(pageKeyOk('project:relative')).toBe(false)
    expect(pageKeyOk(42)).toBe(false)
  })
  it('gives each workspace folder its own persistent partition, stable across launches', () => {
    expect(partitionFor('/Users/me/app')).toMatch(/^persist:cockpit-web-[0-9a-f]{16}$/)
    expect(partitionFor('/Users/me/app')).toBe(partitionFor('/Users/me/app'))
    expect(partitionFor('/Users/me/other')).not.toBe(partitionFor('/Users/me/app'))
  })
})
