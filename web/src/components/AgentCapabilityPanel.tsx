import type { AgentCapabilities } from '../api.ts'
import { formatWhen } from '../usage.ts'

const AUTH_LINE: Record<AgentCapabilities['auth']['state'], string> = {
  signed_in: 'Signed in',
  signed_out: 'Not signed in',
  unknown: 'Sign-in not confirmed',
  not_checked: 'Sign-in not checked',
}

/**
 * What Cockpit checked about the executable it will run (W10.1): where it is, who installed it,
 * sign-in and when that was checked. Refresh checks again now; nothing is checked in the background.
 */
export function AgentCapabilityPanel({ caps, refreshing, error, onRefresh }: {
  caps: AgentCapabilities | undefined
  refreshing: boolean
  error?: string
  onRefresh: () => void
}) {
  const identity = caps && caps.executable.state !== 'missing' ? caps.executable.identity : undefined
  const checked = caps?.probedAt ? `Checked ${formatWhen(Date.parse(caps.probedAt))}${caps.stale ? ', may be out of date' : ''}` : 'Not checked yet'
  const auth = caps?.auth
  return (
    <div className="agent-capabilities" role="group" aria-label="Checked details">
      {identity ? <p className="agent-state-note" title={identity.realpath}>{identity.path}{caps?.manager ? ` · ${caps.manager.label}` : ''}</p> : null}
      {auth && auth.state !== 'not_checked' ? (
        <p className={`agent-state-note${auth.state === 'signed_out' ? ' agent-state-problem' : ''}`}>
          {AUTH_LINE[auth.state]}{auth.detail ? ` · ${auth.detail}` : ''}{auth.state !== 'signed_in' && auth.reason ? `: ${auth.reason}` : ''}
        </p>
      ) : null}
      {caps?.changedDuringProbe ? <p className="agent-state-note agent-state-problem">The CLI was replaced while Cockpit checked it, probably by its own updater. Refresh again.</p> : null}
      {error ? <p className="agent-state-note agent-state-problem" role="alert">{error}</p> : null}
      <p className="agent-state-note agent-capabilities-foot">
        <span>{refreshing ? 'Checking…' : checked}</span>
        <button type="button" className="button-soft" disabled={refreshing} onClick={onRefresh}>Refresh</button>
      </p>
    </div>
  )
}
