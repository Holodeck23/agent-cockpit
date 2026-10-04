import { describe, expect, it } from 'vitest'
import { DEFAULT_NOTIFY, notificationText, parseNotify } from '../web/src/mac-notifications.ts'

describe('Mac notification settings', () => {
  it('are on unless turned off, and tolerate bad storage', () => {
    expect(DEFAULT_NOTIFY).toEqual({ reply: true, decision: true })
    expect(parseNotify(null)).toEqual(DEFAULT_NOTIFY)
    expect(parseNotify('nonsense')).toEqual(DEFAULT_NOTIFY)
    expect(parseNotify('{"reply":false}')).toEqual({ reply: false, decision: true })
  })
})

describe('notificationText', () => {
  const thread = { meta: { title: 'Deploy the site' }, preview: 'All checks passed and the preview is live.', status: 'done' as const }
  it('a finished turn says it finished, with the reply as the body', () => {
    expect(notificationText(thread, 'reply')).toEqual({ title: 'Deploy the site', body: 'Finished: All checks passed and the preview is live.' })
  })

  it('a decision says what kind: an approval, a question or a blocker', () => {
    expect(notificationText({ ...thread, status: 'needs_input' }, 'decision').body).toBe('Waiting for your approval')
    expect(notificationText({ ...thread, status: 'needs_input', asking: 'Which colour?' }, 'decision').body).toBe('Question: Which colour?')
    expect(notificationText({ ...thread, awaiting: 'question', preview: 'Question: Staging or production?' }, 'decision').body).toBe('Question: Staging or production?')
    expect(notificationText({ ...thread, awaiting: 'blocker', preview: 'Blocked: no network' }, 'decision').body).toBe('Blocked: no network')
    // The list preview drops the prefix; the notification puts it back.
    expect(notificationText({ ...thread, awaiting: 'question', preview: 'Staging or production?' }, 'decision').body).toBe('Question: Staging or production?')
    expect(notificationText({ ...thread, awaiting: 'blocker', preview: 'No network' }, 'decision').body).toBe('Blocked: No network')
  })

  it('keeps titles and bodies short', () => {
    const long = notificationText({ ...thread, meta: { title: 'x'.repeat(300) }, preview: 'y'.repeat(500) }, 'reply')
    expect(long.title.length).toBeLessThanOrEqual(80)
    expect(long.body.length).toBeLessThanOrEqual(160)
  })
})
