// Crash and error reports to Sentry, sent only after the person says yes (asked once, on first
// launch; changed later in Settings). The SDK starts before the app is ready, as it must to catch
// native crashes, but its only way out is the gate below: until the answer is yes, every report,
// crash dump and session is dropped on this Mac, never queued or sent.
import type { Transport } from '@sentry/core'
import * as Sentry from '@sentry/electron/main'
import { homedir } from 'node:os'
import { DROPPED_INTEGRATIONS, readChoice, scrubEvent, writeChoice } from './telemetry-choice.ts'

export interface ReportsStatus {
  /** False in builds that do not report at all (development, proofs without a collector). */
  readonly available: boolean
  /** True once the person has answered, either way. */
  readonly decided: boolean
  readonly reports: boolean
}

export interface Telemetry {
  status(): ReportsStatus
  set(reports: boolean): ReportsStatus
  /** An uncaught error in the page, passed on by the preload (the page's own policy keeps the SDK out). */
  pageError(error: { message: string; stack?: string }): void
}

/** A page stuck in a loop of errors sends a few, not thousands. */
const PAGE_ERRORS_PER_RUN = 20

const OFF: Telemetry = {
  status: () => ({ available: false, decided: false, reports: false }),
  set: () => ({ available: false, decided: false, reports: false }),
  pageError: () => undefined,
}

export function startTelemetry(options: { dsn: string | undefined; choiceFile: string; version: string; releaseBuild: boolean }): Telemetry {
  const { dsn, choiceFile, version, releaseBuild } = options
  if (!dsn) return OFF
  let choice = readChoice(choiceFile)
  const allowed = (): boolean => choice?.reports === true
  const home = homedir()
  const gate = (inner: Transport): Transport => ({
    send: (envelope) => (allowed() ? inner.send(envelope) : Promise.resolve({})),
    flush: (timeout) => inner.flush(timeout),
  })
  const offline = Sentry.makeElectronOfflineTransport((transportOptions) => gate(Sentry.makeElectronTransport(transportOptions)))

  Sentry.init({
    dsn,
    release: `cockpit@${version}`,
    environment: releaseBuild ? 'production' : 'proof',
    // No machine name, IP address or user: a report says what broke, not who it broke for.
    serverName: 'cockpit',
    sendDefaultPii: false,
    attachScreenshot: false,
    integrations: (defaults) => defaults.filter((integration) => !DROPPED_INTEGRATIONS.has(integration.name)),
    beforeBreadcrumb: () => null,
    beforeSend: (event) => scrubEvent(event, home),
    // The crash guard (electron/crash-guard.ts) decides what an uncaught error does: Cockpit keeps
    // running. The SDK only reports it, never exits or shows Electron's error dialog.
    onFatalError: () => undefined,
    // Gated twice: outside the offline queue, so a report sent without a yes is never stored, and
    // inside it, so a report queued while offline is not sent after the answer turns to no.
    transport: (transportOptions) => gate(offline(transportOptions)),
  })

  const status = (): ReportsStatus => ({ available: true, decided: choice !== undefined, reports: allowed() })
  let pageErrors = 0
  return {
    status,
    pageError({ message, stack }) {
      if (!allowed() || pageErrors >= PAGE_ERRORS_PER_RUN) return
      pageErrors += 1
      const error = new Error(message.slice(0, 2000))
      error.name = 'PageError'
      if (stack) error.stack = stack.slice(0, 8000)
      Sentry.captureException(error, { tags: { process: 'page' }, level: 'error' })
    },
    set(reports) {
      try {
        choice = writeChoice(choiceFile, reports)
      } catch (error) {
        // Unsaved, the answer still holds for this run; the question comes back next launch.
        console.error('[cockpit] could not save the crash-report choice:', error)
        choice = { reports, decidedAt: new Date().toISOString() }
      }
      return status()
    },
  }
}
