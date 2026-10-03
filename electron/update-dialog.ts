// The words shown for each update-check outcome. Kept apart from Electron so every outcome
// can be tested; a failed check must never read as "up to date".
import { HELP } from '../server/help-links.ts'
import type { UpdateCheck } from './updates.ts'

export interface UpdateDialog {
  readonly type: 'info' | 'warning'
  readonly message: string
  readonly detail: string
  readonly buttons: readonly string[]
  /** Set only when the first button downloads; the caller re-validates it before opening. */
  readonly downloadUrl?: string
  /** Set when the second button opens this troubleshooting page; Escape stays on OK. */
  readonly helpUrl?: string
}

const NOT_UP_TO_DATE = 'This does not mean Cockpit is up to date.'

const REPLACE_STEPS =
  'Download Update opens the installer in your browser. When the download finishes, finish or stop any running agents, ' +
  'quit Cockpit, open the downloaded file and drag Cockpit to Applications to replace this copy. ' +
  'Your conversations and settings are stored outside the app and are kept.'

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function updateDialog(result: UpdateCheck): UpdateDialog {
  switch (result.state) {
    case 'available': {
      const { update } = result
      const notes = update.notes ? `\n\n${update.notes}` : ''
      return {
        type: 'info',
        message: `Cockpit ${update.version} is available`,
        detail: `You have ${result.current}.${notes}\n\n${REPLACE_STEPS}`,
        buttons: ['Download Update', 'Later'],
        downloadUrl: update.downloadUrl,
      }
    }
    case 'up-to-date':
      return {
        type: 'info',
        message: "You're up to date",
        detail: result.latest
          ? `Cockpit ${result.current} is the newest version available.`
          : `No published Cockpit releases were found. You have ${result.current}.`,
        buttons: ['OK'],
      }
    case 'no-compatible-download':
      return {
        type: 'info',
        message: 'Update not ready to download',
        detail: `Cockpit ${result.latest} has been published, but its Apple-silicon installer is not available yet. Try again later. You have ${result.current}.`,
        buttons: ['OK'],
      }
    case 'rate-limited':
      return {
        type: 'warning',
        message: "Couldn't check for updates",
        detail: `GitHub is limiting update checks from this network. Try again ${result.resetAt ? `after ${formatTime(result.resetAt)}` : 'in a few minutes'}. ${NOT_UP_TO_DATE}`,
        buttons: ['OK'],
      }
    case 'unavailable':
      return {
        type: 'warning',
        message: "Couldn't check for updates",
        detail: `${result.reason} ${NOT_UP_TO_DATE}`,
        buttons: ['OK', 'Troubleshooting'],
        helpUrl: HELP.network,
      }
  }
}
