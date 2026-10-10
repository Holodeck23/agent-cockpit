import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Envelope } from '@sentry/core'
import { BETA_TERMS_VERSION, readTerms, reportEnvelope, reportingDsn, scrubEvent, SENTRY_DSN, writeTerms } from '../electron/telemetry-choice.ts'

describe('where reports go', () => {
  it('a release build reports to Cockpit\'s project, whatever the environment says', () => {
    expect(reportingDsn(true, {})).toBe(SENTRY_DSN)
    expect(reportingDsn(true, { COCKPIT_SENTRY_DSN: 'http://k@127.0.0.1:9/1' })).toBe(SENTRY_DSN)
  })

  it('any other build reports only to a proof\'s own collector on this Mac', () => {
    expect(reportingDsn(false, {})).toBeUndefined()
    expect(reportingDsn(false, { COCKPIT_SENTRY_DSN: 'http://k@127.0.0.1:51234/1' })).toBe('http://k@127.0.0.1:51234/1')
    expect(reportingDsn(false, { COCKPIT_SENTRY_DSN: SENTRY_DSN })).toBeUndefined()
    expect(reportingDsn(false, { COCKPIT_SENTRY_DSN: 'http://k@example.com:80/1' })).toBeUndefined()
  })
})

describe('the beta terms', () => {
  it('are not accepted until written, and a damaged or older acceptance does not count', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-terms-'))
    const file = join(dir, 'beta-terms.json')
    expect(readTerms(file)).toBeUndefined()
    writeFileSync(file, '{"version":"1"}')
    expect(readTerms(file)).toBeUndefined()
    writeFileSync(file, JSON.stringify({ version: BETA_TERMS_VERSION - 1, acceptedAt: '2026-10-08T13:00:00.000Z', via: 'app' }))
    expect(readTerms(file)).toBeUndefined()
    const saved = writeTerms(file, 'app', new Date('2026-10-08T13:00:00Z'))
    expect(saved).toEqual({ version: BETA_TERMS_VERSION, acceptedAt: '2026-10-08T13:00:00.000Z', via: 'app' })
    expect(readTerms(file)).toEqual(saved)
  })

  it('accepts what install.sh writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-terms-'))
    const file = join(dir, 'beta-terms.json')
    writeFileSync(file, `{"version":${BETA_TERMS_VERSION},"acceptedAt":"2026-10-08T14:00:00Z","via":"installer"}\n`)
    expect(readTerms(file)).toEqual({ version: BETA_TERMS_VERSION, acceptedAt: '2026-10-08T14:00:00Z', via: 'installer' })
    expect(JSON.parse(readFileSync(file, 'utf8')).via).toBe('installer')
  })
})

describe('what a report keeps', () => {
  const home = '/Users/someone'
  const event = {
    message: 'ENOENT: no such file, open \'/Users/someone/repos/client-x/notes.md\'',
    server_name: 'Someones-MacBook-Pro',
    user: { ip_address: '{{auto}}' },
    request: { url: 'http://127.0.0.1:5173/?key=secret-window-key' },
    breadcrumbs: [{ message: 'console: the prompt text' }],
    exception: { values: [{ value: 'failed at http://127.0.0.1:5173/api/threads?key=abc#x', stacktrace: { frames: [{ abs_path: '/Users/someone/Applications/Cockpit.app/x.js' }] } }] },
    contexts: { os: { name: 'macOS', version: '26.5' }, device: { arch: 'arm64', boot_time: '2026-09-13T11:24:11.016Z' } },
    release: 'cockpit@0.1.6',
  }

  it('shortens the home folder, drops page queries, and removes machine name, user, request and trail', () => {
    const scrubbed = scrubEvent(event, home)
    expect(scrubbed).toEqual({
      message: 'ENOENT: no such file, open \'~/repos/client-x/notes.md\'',
      exception: { values: [{ value: 'failed at http://127.0.0.1:5173/api/threads', stacktrace: { frames: [{ abs_path: '~/Applications/Cockpit.app/x.js' }] } }] },
      contexts: { os: { name: 'macOS', version: '26.5' }, device: { arch: 'arm64' } },
      release: 'cockpit@0.1.6',
    })
    expect(JSON.stringify(scrubbed)).not.toMatch(/someone|secret|MacBook|prompt text/)
  })

  it('returns a new event and leaves the original as it was', () => {
    const before = JSON.stringify(event)
    expect(scrubEvent(event, home)).not.toBe(event)
    expect(JSON.stringify(event)).toBe(before)
  })

  // The contexts @sentry/electron 7.20.0 attached to a real page error (proof:reports, 2026-10-08):
  // the terms promise the kind of Mac, not its time zone, language, screen or graphics chip.
  it('keeps the kind of Mac but drops time zone, language, screen and graphics chip', () => {
    const contexts = {
      os: { name: 'macOS', version: '26.5.1', build: '25F80' },
      device: { arch: 'arm64', memory_size: 17179869184, processor_count: 10, cpu_description: 'Apple M5', family: 'Desktop', screen_density: 2, screen_resolution: '3024x1964' },
      culture: { locale: 'en-US', timezone: 'Europe/Vienna' },
      gpu: { name: 'GPU', vendor_id: '0x106b' },
      app: { app_name: 'Cockpit', app_version: '0.1.7' },
    }
    expect(scrubEvent({ contexts }, home)).toEqual({ contexts: {
      os: contexts.os,
      device: { arch: 'arm64', memory_size: 17179869184, processor_count: 10, cpu_description: 'Apple M5', family: 'Desktop' },
      app: contexts.app,
    } })
  })

  it('drops source excerpts and local variables even if an integration supplies them', () => {
    const frame = { filename: 'main.cjs', lineno: 12, context_line: 'private file text', pre_context: ['private'], post_context: ['private'], vars: { prompt: 'private' } }
    expect(scrubEvent({ exception: { values: [{ stacktrace: { frames: [frame] } }] } }, home)).toEqual({
      exception: { values: [{ stacktrace: { frames: [{ filename: 'main.cjs', lineno: 12 }] } }] },
    })
  })
})

describe('the complete transport payload', () => {
  // Sentry's Envelope type allows one item family per envelope literal; a crash envelope mixes them.
  const envelope = (value: unknown): Envelope => value as Envelope
  it('retains crash metadata while removing native memory dumps and all other attachments', () => {
    const input = envelope([{ event_id: 'crash' }, [
      [{ type: 'event' }, { platform: 'native', level: 'fatal' }],
      [{ type: 'attachment', length: 3, filename: 'crash.dmp', attachment_type: 'event.minidump' }, new Uint8Array([1, 2, 3])],
      [{ type: 'attachment', length: 13, filename: 'private.txt' }, 'file contents'],
    ]])
    expect(reportEnvelope(input)).toEqual([{ event_id: 'crash' }, [[{ type: 'event' }, { platform: 'native', level: 'fatal' }]]])
    expect(input[1]).toHaveLength(3)
  })

  it('retains versioned session counts, but drops logs and attachment-only payloads', () => {
    const session = envelope([{}, [[{ type: 'session' }, {
      sid: 'test', init: true, timestamp: '2026-10-08T00:00:00Z', started: '2026-10-08T00:00:00Z',
      status: 'ok', errors: 0, attrs: { release: 'cockpit@0.1.5' },
    }]]])
    expect(reportEnvelope(session)).toEqual(session)
    expect(reportEnvelope(envelope([{}, [[{ type: 'attachment', length: 13, filename: 'private.txt' }, 'file contents']]]))).toBeUndefined()
    expect(reportEnvelope(envelope([{}, [[{ type: 'log', item_count: 1, content_type: 'application/vnd.sentry.items.log+json' }, { items: [] }]]]))).toBeUndefined()
  })
})
