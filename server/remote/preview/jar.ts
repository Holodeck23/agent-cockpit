// The app's cookies for one phone and one service, kept on the Mac (W11.2): upstream Set-Cookie
// never reaches the browser, and the matching cookies are added only to that service's upstream
// requests. Normal path and expiry rules apply; the domain is the one upstream host, so it is not
// tracked. Memory only, never written to disk.

export interface JarCookie {
  readonly value: string
  readonly path: string
  /** Epoch ms; absent for a session cookie. */
  readonly expires?: number
}

export type CookieJar = Map<string, JarCookie>

const keyOf = (name: string, path: string): string => `${path}\n${name}`

/** The default path of RFC 6265 §5.1.4: the request path up to its last slash. */
function defaultPath(requestPath: string): string {
  const path = requestPath.split('?')[0] ?? '/'
  if (!path.startsWith('/') || path.lastIndexOf('/') === 0) return '/'
  return path.slice(0, path.lastIndexOf('/'))
}

const pathMatches = (cookiePath: string, requestPath: string): boolean => {
  const path = requestPath.split('?')[0] || '/'
  if (path === cookiePath) return true
  if (!path.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || path.charAt(cookiePath.length) === '/'
}

/** Takes every Set-Cookie the upstream sent into the jar; a past expiry or Max-Age=0 removes it. */
export function absorb(jar: CookieJar, setCookie: string | readonly string[] | undefined, requestPath: string, now = Date.now()): void {
  for (const line of [setCookie ?? []].flat()) {
    const [pair = '', ...attributes] = line.split(';')
    const eq = pair.indexOf('=')
    if (eq < 1) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    let path = defaultPath(requestPath)
    let expires: number | undefined
    let maxAge: number | undefined
    for (const attribute of attributes) {
      const [rawKey = '', ...rest] = attribute.split('=')
      const key = rawKey.trim().toLowerCase()
      const v = rest.join('=').trim()
      if (key === 'path' && v.startsWith('/')) path = v
      else if (key === 'expires') { const t = Date.parse(v); if (!Number.isNaN(t)) expires = t }
      else if (key === 'max-age' && /^-?\d+$/.test(v)) maxAge = Number(v)
    }
    if (maxAge !== undefined) expires = now + maxAge * 1000
    const key = keyOf(name, path)
    if (expires !== undefined && expires <= now) jar.delete(key)
    else jar.set(key, { value, path, ...(expires !== undefined ? { expires } : {}) })
  }
}

/** The Cookie header for an upstream request to `requestPath`, or undefined when none apply. */
export function cookieHeader(jar: CookieJar, requestPath: string, now = Date.now()): string | undefined {
  const sent: Array<[string, JarCookie]> = []
  for (const [key, cookie] of jar) {
    if (cookie.expires !== undefined && cookie.expires <= now) { jar.delete(key); continue }
    if (pathMatches(cookie.path, requestPath)) sent.push([key.split('\n')[1] ?? '', cookie])
  }
  // Longer paths first (RFC 6265 §5.4).
  sent.sort((a, b) => b[1].path.length - a[1].path.length)
  return sent.length ? sent.map(([name, c]) => `${name}=${c.value}`).join('; ') : undefined
}
