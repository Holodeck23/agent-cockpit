import { originClass, originOf } from '../server/browser/agent-policy.ts'
import type { BrowserHost } from '../server/browser/agent.ts'

/**
 * Preview tools do not grant website access. Arm this before restoring or loading their page: a local address
 * that answers with a redirect (at once, later, or through a popup) to a website is refused before the request
 * goes out, and a website is opened with browser_navigate, which asks first.
 */
export function guardLocalPreview(host: BrowserHost, key: string, cockpitPorts: () => readonly number[]): void {
  host.guardNavigation(key, async (url) => {
    if (originClass(url, cockpitPorts()) !== 'local') {
      throw new Error(`The preview redirects to ${originOf(url) ?? 'another site'}, not your local app. Use browser_navigate for other sites; it asks you first.`)
    }
  })
}
