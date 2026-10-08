// Crash and error reports: the person's choice, which reports are sent with, and what is taken out
// of each report first. Kept apart from Electron and the SDK so every rule here can be tested.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Envelope } from '@sentry/core'

/**
 * Cockpit's Sentry project (David's, EU region). A DSN only lets a client send reports to the
 * project; it is meant to ship inside the app, as every installed copy carries it anyway.
 */
export const SENTRY_DSN = 'https://891d3a273fd7ddee445a3d7e2ce94ce2@o4512220829253632.ingest.de.sentry.io/4512220839149648'

/**
 * Release builds report to Cockpit's project. Any other build reports only when a proof points it
 * at its own collector, so development and proof runs never reach the real project.
 */
export function reportingDsn(releaseBuild: boolean, env: NodeJS.ProcessEnv): string | undefined {
  if (releaseBuild) return SENTRY_DSN
  const proof = env.COCKPIT_SENTRY_DSN
  return proof && /^http:\/\/[^@/]+@127\.0\.0\.1:\d+\/\d+$/.test(proof) ? proof : undefined
}

export interface ReportsChoice {
  /** True only after the person said yes. */
  readonly reports: boolean
  readonly decidedAt: string
}

/** The stored choice; undefined until the person has answered (a damaged file counts as unanswered). */
export function readChoice(file: string): ReportsChoice | undefined {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<ReportsChoice>
    return typeof value.reports === 'boolean' && typeof value.decidedAt === 'string' ? { reports: value.reports, decidedAt: value.decidedAt } : undefined
  } catch {
    return undefined
  }
}

export function writeChoice(file: string, reports: boolean, now: Date = new Date()): ReportsChoice {
  const choice: ReportsChoice = { reports, decidedAt: now.toISOString() }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(`${file}.tmp`, `${JSON.stringify(choice)}\n`, { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
  return choice
}

/** Default integrations a report never uses: they would add local variables, logs or a request trail. */
export const DROPPED_INTEGRATIONS: ReadonlySet<string> = new Set([
  'LocalVariables', 'ContextLines', 'Console', 'ElectronBreadcrumbs', 'ElectronNet',
  'Screenshots', 'PreloadInjection', 'RendererEventLoopBlock',
])

/** Native minidumps contain process memory and bypass beforeSend's event scrubber. Never upload
 * attachments (or profiles, logs, replay, etc.); retain only error/crash metadata and sessions.
 * Apply before the offline queue as well as at its transport boundary. */
export function reportEnvelope<T extends Envelope>(envelope: T): T | undefined {
  const items = envelope[1].filter(([header]) => header.type === 'event' || header.type === 'session')
  // Removing items preserves the incoming envelope family and its matching header.
  return items.length ? [envelope[0], items] as T : undefined
}

type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json }

function scrubString(text: string, home: string): string {
  const shortened = home.length > 1 ? text.split(home).join('~') : text
  // The page's own address can carry its window key; a report needs the path at most.
  return shortened.replace(/(https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?[^\s?#"']*)[?#][^\s"']*/g, '$1')
}

function scrubValue(value: Json, home: string): Json {
  if (typeof value === 'string') return scrubString(value, home)
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, home))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      // Source excerpts and local variables; boot_time, which with the hardware nearly names the Mac.
      .filter(([key]) => !['vars', 'pre_context', 'context_line', 'post_context', 'boot_time'].includes(key))
      .map(([key, item]) => [scrubString(key, home), scrubValue(item, home)]))
  }
  return value
}

/**
 * What leaves the Mac: the error and its stack, versions and the kind of Mac. The home folder
 * becomes ~, page addresses lose their query, and the machine name, user, request and trail are
 * removed. Returns a new event; the one given is not changed.
 */
export function scrubEvent<T extends object>(event: T, home: string): T {
  const { server_name: _server, user: _user, request: _request, breadcrumbs: _trail, ...rest } = event as T & Record<string, unknown>
  return scrubValue(rest as Json, home) as T
}
