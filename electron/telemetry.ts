// Crash and error reports to Sentry, on by default (David 2026-10-08: no question at first launch).
// The first launch says so once; Settings turns them off. The SDK starts before the app is ready,
// as it must to catch native crashes, and its only way out is the gate below: once turned off,
// every report and session is dropped on this Mac, never queued or sent.
import type { Transport } from '@sentry/core'
import * as Sentry from '@sentry/electron/main'
import { homedir } from 'node:os'
import { DROPPED_INTEGRATIONS, readChoice, reportEnvelope, scrubEvent, writeChoice } from './telemetry-choice.ts'

export interface ReportsStatus {
  /** False in builds that do not report at all (development, proofs without a collector). */
  readonly available: boolean
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
  status: () => ({ available: false, reports: false }),
  set: () => ({ available: false, reports: false }),
  pageError: () => undefined,
}

export function startTelemetry(options: { dsn: string | undefined; choiceFile: string; version: string; releaseBuild: boolean }): Telemetry {
  const { dsn, choiceFile, version, releaseBuild } = options
  if (!dsn) return OFF
  let choice = readChoice(choiceFile)
  // On unless the person turned reports off in Settings.
  const allowed = (): boolean => choice?.reports !== false
  const home = homedir()
  const gate = (inner: Transport): Transport => ({
    send: (envelope) => {
      const filtered = allowed() ? reportEnvelope(envelope) : undefined
      return filtered ? inner.send(filtered) : Promise.resolve({})
    },
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
    // Cockpit already has an origin- and window-scoped error bridge. Do not install the SDK's
    // renderer IPC/protocol surface or a preload into browsers/previews sharing Electron sessions.
    ipcMode: 0 as Sentry.IPCMode,
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

  const status = (): ReportsStatus => ({ available: true, reports: allowed() })
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
        // Unsaved, the setting still holds for this run; the next launch starts from the default.
        console.error('[cockpit] could not save the crash-report choice:', error)
        choice = { reports, decidedAt: new Date().toISOString() }
      }
      return status()
    },
  }
}
