import { useCallback, useEffect, useState } from 'react'
import type { AgentId } from '../../../server/agents/types.ts'
import { api, type AgentCapabilities, type AgentLifecycleView, type OperationKind, type OperationView, type Plan } from '../api.ts'
import { formatWhen } from '../usage.ts'

// Install, update and sign in for the selected agent's CLI (W10.2/W10.3). Each action first shows
// where it goes and what to expect, and runs only on an explicit confirm. Desktop only.

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const RUNNING = new Set<OperationView['state']>(['installing', 'updating', 'waiting_for_user', 'waiting_for_idle'])
const TITLE: Record<OperationKind, string> = { install: 'Install', update: 'Update', signin: 'Sign in' }
const STATE: Partial<Record<OperationView['state'], string>> = {
  installing: 'Installing…', updating: 'Updating…', waiting_for_user: 'Waiting for you to sign in…', waiting_for_idle: 'Waiting to update',
  pending_confirmation: 'Update waiting for confirmation', installed: 'Installed', auth_needed: 'Installed, sign-in needed', updated: 'Updated',
  incompatible: 'Installed but not usable by Cockpit', verified: 'Signed in', unknown: 'Sign-in not confirmed', cancelled: 'Cancelled', error: 'Did not finish',
}

function Manual({ plan }: { plan: Extract<Plan, { available: false }> }) {
  return (
    <p className="agent-state-note">
      {plan.reason}
      {plan.manual ? <> Run it yourself in Terminal, then Refresh: <code className="lifecycle-command">{plan.manual}</code></> : null}
    </p>
  )
}

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  const s = Math.max(0, Math.round((now - Date.parse(since)) / 1000))
  return <span>{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>
}

function Operation({ op, onChange }: { op: OperationView; onChange: (next: OperationView) => void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const act = (action: () => Promise<unknown>): void => { setError(''); action().then(() => api.agentOperation(op.id).then(onChange), (e: unknown) => setError(message(e))) }
  const running = RUNNING.has(op.state)
  return (
    <div className="lifecycle-op" role="status" aria-live="polite">
      <p className="agent-state-line">{TITLE[op.kind]}: {STATE[op.state] ?? op.state} {running ? <>· <Elapsed since={op.startedAt} /></> : null}</p>
      {op.message ? <p className={`agent-state-note${op.state === 'error' || op.state === 'incompatible' ? ' agent-state-problem' : ''}`}>{op.message}</p> : null}
      {op.manual ? <p className="agent-state-note">Run it yourself in Terminal, then Refresh: <code className="lifecycle-command">{op.manual}</code></p> : null}
      {op.lines.length > 0 ? <pre className="lifecycle-output">{op.lines.slice(-6).join('\n')}</pre> : null}
      {op.state === 'waiting_for_user' ? (
        <div className="lifecycle-input">
          <input type="password" autoComplete="off" aria-label="Sign-in code" placeholder="Paste the code if asked" value={code} onChange={(e) => setCode(e.target.value)} />
          <button type="button" className="button-soft" disabled={!code.trim()} onClick={() => { const text = code.trim(); setCode(''); act(() => api.sendAgentOperationInput(op.id, text)) }}>Send</button>
        </div>
      ) : null}
      <div className="lifecycle-actions">
        {op.state === 'pending_confirmation' ? <button type="button" className="button-soft" onClick={() => act(() => api.resumeAgentOperation(op.id))}>Resume update</button> : null}
        {running || op.state === 'pending_confirmation' ? <button type="button" className="button-soft" onClick={() => act(() => api.cancelAgentOperation(op.id))}>Cancel</button> : null}
      </div>
      {error ? <p className="agent-state-note agent-state-problem" role="alert">{error}</p> : null}
    </div>
  )
}

/** One action: shown with its destination and expectations, confirmed, then started. */
function Action({ kind, plan, label, onStart }: { kind: OperationKind; plan: Extract<Plan, { available: true }>; label: string; onStart: (kind: OperationKind) => void }) {
  const [confirming, setConfirming] = useState(false)
  if (!confirming) return <button type="button" className="button-soft" onClick={() => setConfirming(true)}>{label}…</button>
  return (
    <div className="lifecycle-confirm">
      <p className="agent-state-note">
        {kind === 'install' ? `Installs to ${plan.destination} with the official installer. ` : kind === 'update' ? `Updates ${plan.destination}. ` : ''}
        {plan.interaction}
      </p>
      <div className="lifecycle-actions">
        <button type="button" className="button-primary" onClick={() => { setConfirming(false); onStart(kind) }}>{label}</button>
        <button type="button" className="button-soft" onClick={() => setConfirming(false)}>Not now</button>
      </div>
    </div>
  )
}

export function AgentLifecycle({ agent, caps, onChanged }: { agent: AgentId; caps: AgentCapabilities | undefined; onChanged: () => void }) {
  const [view, setView] = useState<AgentLifecycleView>()
  const [op, setOp] = useState<OperationView>()
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const load = useCallback(() => {
    api.agentLifecycle(agent).then((next) => {
      setView(next)
      setOp((shown) => next.operations.find((o) => !o.endedAt) ?? (shown?.agent === agent ? shown : undefined))
    }, (e: unknown) => setError(message(e)))
  }, [agent])
  useEffect(() => { setOp(undefined); setError(''); load() }, [load, caps?.probedAt])

  // Follow a running operation; when it ends, the CLI is read again.
  const running = op !== undefined && (RUNNING.has(op.state) || op.state === 'pending_confirmation')
  useEffect(() => {
    if (!op || !running) return
    const timer = setInterval(() => {
      api.agentOperation(op.id).then((next) => {
        setOp(next)
        if (next.endedAt) { onChanged(); load() }
      }, () => undefined)
    }, 1000)
    return () => clearInterval(timer)
  }, [op?.id, running, onChanged, load])

  const start = (kind: OperationKind): void => {
    setError('')
    api.startAgentOperation(agent, kind).then(setOp, (e: unknown) => setError(message(e)))
  }
  const check = (): void => {
    setChecking(true)
    api.checkAgentUpdate(agent).then(() => load(), (e: unknown) => setError(message(e))).finally(() => setChecking(false))
  }
  if (!view || !caps) return error ? <p className="agent-state-note agent-state-problem" role="alert">{error}</p> : null
  const missing = caps.executable.state === 'missing'
  const latest = view.latest
  const needsSignin = caps.executable.state === 'found' && (caps.auth.state === 'signed_out' || caps.auth.state === 'unknown')
  return (
    <div className="agent-lifecycle" role="group" aria-label="Install and updates">
      {op ? <Operation op={op} onChange={(next) => { setOp(next); if (next.endedAt) { onChanged(); load() } }} /> : null}
      {!running && missing ? (view.install.available ? <Action kind="install" plan={view.install} label="Install" onStart={start} /> : <Manual plan={view.install} />) : null}
      {!running && needsSignin ? (view.signin.available ? <Action kind="signin" plan={view.signin} label="Sign in" onStart={start} /> : <Manual plan={view.signin} />) : null}
      {!running && !missing ? (
        <div className="lifecycle-updates">
          {latest ? (
            <p className="agent-state-note">
              {latest.state === 'unavailable' ? `Update check: ${latest.reason}`
                : latest.state === 'up_to_date' ? `Up to date (${latest.installed}), per the ${latest.source} at ${formatWhen(Date.parse(latest.checkedAt))}.`
                : latest.state === 'skipped' ? `Version ${latest.latest} is out; you skipped it.`
                : `Version ${latest.latest} is out (you have ${latest.installed}; ${latest.source}, ${formatWhen(Date.parse(latest.checkedAt))}).`}
              {latest.state !== 'unavailable' && latest.note ? ` ${latest.note}` : ''}
            </p>
          ) : null}
          <div className="lifecycle-actions">
            <button type="button" className="button-soft" disabled={checking} onClick={check}>{checking ? 'Checking…' : 'Check for updates'}</button>
            {view.update.available ? <Action kind="update" plan={view.update} label="Update" onStart={start} /> : null}
            {latest?.state === 'available' ? <button type="button" className="button-soft" onClick={() => api.skipAgentVersion(agent, latest.latest).then(load, (e: unknown) => setError(message(e)))}>Skip {latest.latest}</button> : null}
          </div>
          {!view.update.available ? <Manual plan={view.update} /> : null}
        </div>
      ) : null}
      {error ? <p className="agent-state-note agent-state-problem" role="alert">{error}</p> : null}
    </div>
  )
}
