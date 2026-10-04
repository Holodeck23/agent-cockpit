// Plain words for what an agent reported when a turn failed (J10). The full message stays
// available under Details; this only picks the title and pulls the readable part out.

export interface FailureWords {
  readonly title: string
  /** The agent's own message, unwrapped from JSON when it came wrapped. */
  readonly detail: string
}

/** Codex passes API errors on as JSON text; the human part is error.message (or message). */
function unwrap(message: string): string {
  const start = message.indexOf('{')
  if (start < 0) return message.trim()
  try {
    const parsed = JSON.parse(message.slice(start)) as { error?: { message?: unknown }; message?: unknown }
    const inner = typeof parsed.error?.message === 'string' ? parsed.error.message : typeof parsed.message === 'string' ? parsed.message : undefined
    return inner ? `${message.slice(0, start).trim() ? `${message.slice(0, start).trim()} ` : ''}${inner}`.trim() : message.trim()
  } catch {
    return message.trim()
  }
}

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/usage limit|session limit|weekly limit|rate.?limit|limit reached|too many requests|\b429\b|quota/i, 'You have reached a usage limit'],
  [/not (logged|signed) in|log ?in again|authenticat|unauthori[sz]ed|\b401\b|invalid api key|oauth/i, 'The agent is not signed in'],
  [/unsupported value|not supported with the .* model|invalid_request|\b400\b/i, 'The agent refused this request'],
  [/overloaded|\b5\d\d\b|internal server error|service unavailable/i, "The agent's service had a problem"],
  [/ECONN|ENOTFOUND|EAI_AGAIN|network|fetch failed|socket hang up|timed? ?out/i, "Could not reach the agent's service"],
  [/not running|exited|stopped unexpectedly|killed/i, 'The agent stopped unexpectedly'],
]

/** "…limit reached|1791100800" (seconds) → "…limit reached. Resets Sun 4 Oct, 14:00." in local time. */
function withReset(text: string): string {
  const match = /^(.*?)\|(\d{10})$/.exec(text)
  if (!match) return text
  const when = new Date(Number(match[2]) * 1000).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return `${match[1]!.replace(/\.?$/, '.')} Resets ${when}.`
}

export function failureWords(message: string | undefined): FailureWords {
  const detail = message ? withReset(unwrap(message)) : ''
  const title = RULES.find(([pattern]) => pattern.test(message ?? ''))?.[1] ?? 'The turn failed'
  return { title, detail }
}
