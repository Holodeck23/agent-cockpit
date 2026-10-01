import type { AgentId } from '../../../server/agents/types.ts'

// Author marks for the transcript and the agent picker. Simple generic shapes:
// a person for you, a spark for Claude Code, a prompt for Codex, a four-point star for
// Antigravity, and open brackets for OpenCode.

export function AgentGlyph({ author }: { author: 'you' | AgentId }) {
  if (author === 'you') {
    return (
      <svg className="glyph glyph-you" viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="8.5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <path d="M5 19.5c1.2-3.4 3.9-5 7-5s5.8 1.6 7 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    )
  }
  if (author === 'opencode') {
    return (
      <svg className="glyph glyph-opencode" viewBox="0 0 24 24" aria-hidden>
        <path d="M9 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19H9M15 5h2.5A1.5 1.5 0 0 1 19 6.5v11a1.5 1.5 0 0 1-1.5 1.5H15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      </svg>
    )
  }
  if (author === 'antigravity') {
    return (
      <svg className="glyph glyph-antigravity" viewBox="0 0 24 24" aria-hidden>
        <path d="M12 2.8c.7 5.2 4 8.5 9.2 9.2-5.2.7-8.5 4-9.2 9.2-.7-5.2-4-8.5-9.2-9.2 5.2-.7 8.5-4 9.2-9.2Z" fill="currentColor" />
      </svg>
    )
  }
  if (author === 'codex') {
    return (
      <svg className="glyph glyph-codex" viewBox="0 0 24 24" aria-hidden>
        <rect x="3" y="4" width="18" height="16" rx="4" fill="currentColor" opacity="0.14" />
        <path d="m8 10 3 2.5L8 15M13 15h3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <svg className="glyph glyph-claude" viewBox="0 0 24 24" aria-hidden>
      <g stroke="currentColor" strokeWidth="2.1" strokeLinecap="round">
        {[0, 30, 60, 90, 120, 150].map((angle) => (
          <path key={angle} d="M12 3.5v17" transform={`rotate(${angle} 12 12)`} />
        ))}
      </g>
    </svg>
  )
}
