// Address rules shared by the in-app browser's host policy (electron/browser-policy.ts) and its
// address field (web). No Node or Electron imports: the page bundles this too.

/** True for every way a URL can name this machine: Chromium resolves all of these to loopback. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(host)
    || host === '[::1]' || host === '[::]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host)
}

/**
 * What the person typed in the address field, as a URL to load, or undefined when it is not an
 * http(s) address. A bare host gets https, except local hosts and IP addresses, which get http.
 */
export function addressToUrl(input: string): string | undefined {
  const text = input.trim()
  if (!text || /\s/.test(text)) return undefined
  // "localhost:3000" is a host and port, not a scheme.
  const schemed = /^[a-z][a-z\d+.-]*:/i.test(text) && !/^[^/:]+:\d/.test(text)
  let url: URL
  try {
    if (schemed) url = new URL(text)
    else {
      const host = text.split(/[/:?#]/)[0]!
      const local = isLoopbackHost(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)
      if (!local && !host.includes('.')) return undefined
      url = new URL(`${local ? 'http' : 'https'}://${text}`)
    }
  } catch { return undefined }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
}

/** What the address bar's badge says: Local for this machine, otherwise the site's host. */
export function originLabel(raw: string): string {
  try {
    const url = new URL(raw)
    return isLoopbackHost(url.hostname) ? 'Local' : url.host
  } catch {
    return ''
  }
}
