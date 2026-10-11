import { originClass } from '../server/browser/agent-policy.ts'
import type { BrowserHost } from '../server/browser/agent.ts'

/** Preview tools do not grant website access. Arm this before restoring or loading their page. */
export function guardLocalPreview(host: BrowserHost, key: string, cockpitPorts: () => readonly number[]): void {
  host.guardNavigation(key, async (url) => {
    if (originClass(url, cockpitPorts()) !== 'local') {
      throw new Error('A local preview cannot navigate to another website. Use browser_navigate to request approval.')
    }
  })
}
