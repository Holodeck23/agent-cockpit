// Crash and error reports to Sentry, a condition of the beta (BETA-TERMS.md, David 2026-10-08): the
// terms are accepted when installing from Terminal or at the app's first launch, and there is no
// switch to turn reports off. The SDK starts before the app is ready, as it must to catch native
// crashes; until the terms are accepted the gate below drops everything on this Mac, unsent.

import type { Transport } from '@sentry/core'
import * as Sentry from '@sentry/electron/main'
import { homedir } from 'node:os'
import { DROPPED_INTEGRATIONS, readTerms, reportEnvelope, scrubEvent, writeTerms } from './telemetry-choice.ts'

export interface TermsStatus {
  /** False in builds that do not report at all (development, proofs without a collector): no terms to accept. */
  readonly available: boolean
  readonly accepted: boolean
}

export interface Telemetry {
  status(): TermsStatus
  accept(): TermsStatus
  /** An uncaught error in the page, passed on by the preload (the page's own policy keeps the SDK out). */
  pageError(error: { message: string; stack?: string }): void
}

/** A page stuck in a loop of errors sends a few, not thousands. */
const PAGE_ERRORS_PER_RUN = 20

const OFF: Telemetry = {
  status: () => ({ available: false, accepted: false }),
  accept: () => ({ available: false, accepted: false }),
  pageError: () => undefined,
}

export function startTelemetry(options: { dsn: string | undefined; termsFile: string; version: string; releaseBuild: boolean }): Telemetry {
  const { dsn, termsFile, version, releaseBuild } = options
  if (!dsn) return OFF
  let accepted = readTerms(termsFile) !== undefined
  const allowed = (): boolean => accepted
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
    // Gated twice, outside and inside the offline queue: nothing is stored or sent before the terms are accepted.
    transport: (transportOptions) => gate(offline(transportOptions)),
  })

  const status = (): TermsStatus => ({ available: true, accepted })
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
    accept() {
      try {
        writeTerms(termsFile, 'app')
      } catch (error) {
        // Unsaved, the acceptance still holds for this run; the next launch asks again.
        console.error('[cockpit] could not save the beta terms acceptance:', error)
      }
      accepted = true
      return status()
    },
  }
}
