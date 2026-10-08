import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readChoice, reportingDsn, scrubEvent, SENTRY_DSN, writeChoice } from '../electron/telemetry-choice.ts'

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

describe('the person\'s choice', () => {
  it('is unanswered until written, and a damaged file counts as unanswered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-telemetry-'))
    const file = join(dir, 'reports.json')
    expect(readChoice(file)).toBeUndefined()
    writeFileSync(file, '{"reports":"yes"}')
    expect(readChoice(file)).toBeUndefined()
    const saved = writeChoice(file, true, new Date('2026-10-08T13:00:00Z'))
    expect(saved).toEqual({ reports: true, decidedAt: '2026-10-08T13:00:00.000Z' })
    expect(readChoice(file)).toEqual(saved)
    writeChoice(file, false)
    expect(readChoice(file)?.reports).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8')).reports).toBe(false)
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
    contexts: { os: { name: 'macOS', version: '26.5' } },
    release: 'cockpit@0.1.6',
  }

  it('shortens the home folder, drops page queries, and removes machine name, user, request and trail', () => {
    const scrubbed = scrubEvent(event, home)
    expect(scrubbed).toEqual({
      message: 'ENOENT: no such file, open \'~/repos/client-x/notes.md\'',
      exception: { values: [{ value: 'failed at http://127.0.0.1:5173/api/threads', stacktrace: { frames: [{ abs_path: '~/Applications/Cockpit.app/x.js' }] } }] },
      contexts: { os: { name: 'macOS', version: '26.5' } },
      release: 'cockpit@0.1.6',
    })
    expect(JSON.stringify(scrubbed)).not.toMatch(/someone|secret|MacBook|prompt text/)
  })

  it('returns a new event and leaves the original as it was', () => {
    const before = JSON.stringify(event)
    expect(scrubEvent(event, home)).not.toBe(event)
    expect(JSON.stringify(event)).toBe(before)
  })
})
