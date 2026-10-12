import { originClass, originOf } from '../server/browser/agent-policy.ts'
import type { BrowserHost } from '../server/browser/agent.ts'

/**
 * Preview tools do not grant website access. Arm this before restoring or loading their page: a local address
 * that answers with a redirect (at once, later, or through a popup) to a website is refused before the request
 * goes out, and a website is opened with browser_navigate, which asks first. A click or key of the person's own
 * in the pane lifts the guard: it keeps the page from being sent away, not the person from following a link.
 */
export function guardLocalPreview(host: BrowserHost, key: string, cockpitPorts: () => readonly number[]): void {
  host.guardNavigation(key, async (url) => {
    if (originClass(url, cockpitPorts()) !== 'local') {
      throw new Error(`The preview redirects to ${originOf(url) ?? 'another site'}, not your local app. Use browser_navigate for other sites; it asks you first.`)
    }
    // There is no run behind this guard to end: a link the person clicks in their own app is theirs to follow.
  }, { over: () => true })
}
