import type { ElectronApplication } from 'playwright-core'

/** Keep physical input out of synthetic proofs while preserving native view/layout visibility. */
export async function isolateProofInput(app: ElectronApplication): Promise<void> {
  if (process.env.COCKPIT_PROOF_BACKGROUND !== '1') return
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    electronApp.on('browser-window-created', (_event, window) => {
      window.setFocusable(false)
      window.setIgnoreMouseEvents(true)
      window.setOpacity(0)
    })
    for (const window of BrowserWindow.getAllWindows()) {
      window.setFocusable(false)
      window.setIgnoreMouseEvents(true)
      window.setOpacity(0)
    }
  })
  console.log('[proof] physical-input isolation: transparent, non-focusable native windows')
}
