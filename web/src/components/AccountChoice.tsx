import { useEffect, useRef, useState } from 'react'
import type { AgentId } from '../../../server/agents/types.ts'
import { api, type AccountsView, type AccountView, type SigninView } from '../api.ts'
import { native } from '../native.ts'
import { agentName } from '../transcript.ts'

// The project's account for one agent (W12.1): the CLI default or a named profile. The picker and
// project settings both show this, over the same server-side choice. Changing it applies to every
// conversation on that agent in the project; Add account runs the CLI's own sign-in in a new,
// separate context. Antigravity and OpenCode say why they stay on their CLI default.

const ADD = '__add'
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const accountName = (account: AccountView): string => {
  const who = account.identity?.state === 'known' ? account.identity.hint : account.identity ? 'account unknown' : undefined
  return who ? `${account.label} · ${who}` : account.label
}

/** The project's opaque ID, for the account routes; listed with the projects. */
async function projectIdFor(projectPath: string): Promise<string | undefined> {
  const listed = await api.listProjects() as Array<{ path: string; projectId?: string }>
  return listed.find((p) => p.path === projectPath)?.projectId
}

interface AccountChoiceProps {
  readonly agent: AgentId
  readonly projectPath: string
  /** The account now chosen, so the picker can show that account's usage. */
  readonly onSelected?: (account: AccountView | undefined) => void
  /** Re-read who the CLI defaults are signed in to (default on); one is enough when several show at once. */
  readonly recheck?: boolean
}

export function AccountChoice({ agent, projectPath, onSelected, recheck = true }: AccountChoiceProps) {
  const [view, setView] = useState<AccountsView>()
  const [projectId, setProjectId] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState(false)
  const reported = useRef(onSelected)
  reported.current = onSelected

  // Read each time the agent or project changes; a late answer for another one is dropped.
  useEffect(() => {
    let live = true
    setSelected(undefined)
    setError('')
    setNote('')
    setAdding(false)
    setRemoving(false)
    Promise.all([api.accounts(recheck), projectIdFor(projectPath)]).then(async ([accounts, id]) => {
      if (!live) return
      setView(accounts)
      setProjectId(id)
      if (!id) { setSelected(`default-${agent}`); return }
      const { selection } = await api.projectAccounts(id)
      if (live) setSelected(selection[agent])
    }).catch((e: unknown) => { if (live) setError(message(e)) })
    return () => { live = false }
  }, [agent, projectPath, recheck])

  const mine = (view?.accounts ?? []).filter((a) => a.agent === agent)
  const current = mine.find((a) => a.id === selected)
  const loading = (!view || selected === undefined) && !error
  useEffect(() => { reported.current?.(current) }, [current?.id, current?.generation])

  const support = view?.support[agent]
  if (view && support && !support.profiles) {
    return <p className="picker-note account-default-only" role="note">Account: CLI default. {support.reason}</p>
  }

  const choose = (accountId: string): void => {
    if (!projectId) { setError('Open this project in Cockpit first.'); return }
    setBusy(true)
    setError('')
    setNote('')
    api.selectAccount(projectId, agent, accountId)
      .then(({ selection }) => {
        setSelected(selection[agent])
        setNote(`${agentName(agent)} conversations in this project use this account from their next message.`)
      }, (e: unknown) => setError(message(e)))
      .finally(() => setBusy(false))
  }
  const reload = (): Promise<void> => api.accounts().then(setView, (e: unknown) => setError(message(e)))

  return (
    <div className="account-choice" role="group" aria-label="Account">
      <label className="field">
        Account
        <select aria-label="Account" value={adding ? ADD : loading ? '' : selected ?? ''} disabled={loading || busy} aria-busy={loading}
          onChange={(e) => { if (e.target.value === ADD) { setAdding(true); setRemoving(false) } else { setAdding(false); choose(e.target.value) } }}>
          {/* Until both answers arrive nothing matches, and a select would show its first option
              ("Add an account…") as if it were the account (proof:accounts, first launch 2026-10-08). */}
          {loading ? <option value="">Checking…</option> : null}
          {mine.map((account) => (
            <option key={account.id} value={account.id}>{account.mode === 'default' ? `Use CLI default${account.identity?.state === 'known' ? ` · ${account.identity.hint}` : account.identity ? ' · account unknown' : ''}` : accountName(account)}</option>
          ))}
          <option value={ADD}>Add an account…</option>
        </select>
      </label>
      {current?.identity?.state === 'unknown' ? (
        <p className="picker-note agent-state-problem" role="note">
          {agentName(agent)} did not confirm who is signed in here{current.identity.reason ? ` (${current.identity.reason})` : ''}. Cockpit treats it as unknown, not as the account before.
        </p>
      ) : null}
      <p className="picker-note">
        Applies to every {agentName(agent)} conversation in this project. An idle conversation continued on another account starts a new session there, and the conversation so far goes with it.
      </p>
      {note ? <p className="picker-note" role="status">{note}</p> : null}
      {error ? <p className="picker-note agent-state-problem" role="alert">{error}</p> : null}
      {adding ? (
        <AddAccount agent={agent} takesCode={support?.takesCode === true}
          onDone={(account) => { setAdding(false); void reload().then(() => { if (account) choose(account.id) }) }} />
      ) : null}
      {current?.mode === 'managed' && !adding ? (
        removing ? (
          <div className="account-remove" role="group" aria-label="Remove account">
            <p className="picker-note">
              Remove signs “{current.label}” out in its own context and deletes its folder. Projects using it move to the CLI default. Your {agentName(agent)} account itself, and the CLI default sign-in, are not changed.
            </p>
            <div className="picker-foot">
              <button type="button" className="button-soft" onClick={() => setRemoving(false)}>Keep it</button>
              <button type="button" className="button-primary" disabled={busy} onClick={() => {
                setBusy(true)
                setError('')
                api.removeAccount(current.id, true).then((result) => { setNote(result.message); setRemoving(false); setSelected(`default-${agent}`); return reload() },
                  (e: unknown) => setError(message(e))).finally(() => setBusy(false))
              }}>Remove</button>
            </div>
          </div>
        ) : (
          <button type="button" className="button-soft account-remove-start" onClick={() => setRemoving(true)}>Remove “{current.label}”…</button>
        )
      ) : null}
    </div>
  )
}

/** The CLI's own sign-in, in a new context: its link (for a private window), the code box for Claude, the outcome. */
function AddAccount({ agent, takesCode, onDone }: { agent: AgentId; takesCode: boolean; onDone: (account?: AccountView) => void }) {
  const [label, setLabel] = useState('')
  const [signin, setSignin] = useState<SigninView>()
  const [code, setCode] = useState('')
  const [error, setError] = useState('')

  // Followed while it is open; it ends by itself (done, failed, timed out) or on Cancel.
  useEffect(() => {
    if (!signin || signin.endedAt) return
    const timer = setInterval(() => {
      api.accountSignin(signin.id).then((next) => {
        setSignin(next)
        if (next.state === 'verified') onDone(next.account)
      }, (e: unknown) => setError(message(e)))
    }, 800)
    return () => clearInterval(timer)
  }, [signin?.id, signin?.endedAt])

  if (!signin || (signin.endedAt && signin.state !== 'verified')) {
    return (
      <div className="account-add" role="group" aria-label="Add account">
        {signin?.message ? <p className="picker-note agent-state-problem" role="alert">{signin.message}</p> : null}
        <div className="preset-form">
          <input aria-label="Account name" placeholder="Name, e.g. Work" maxLength={60} value={label} autoFocus onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.preventDefault() }} />
          <button type="button" className="button-primary" disabled={!label.trim()} onClick={() => {
            setError('')
            api.startAccountSignin(agent, label.trim()).then(setSignin, (e: unknown) => setError(message(e)))
          }}>Sign in</button>
          <button type="button" className="button-soft" onClick={() => onDone()}>Cancel</button>
        </div>
        <p className="picker-note">Cockpit runs {agentName(agent)}’s own sign-in in a separate place, so your current sign-in stays as it is.</p>
        {error ? <p className="picker-note agent-state-problem" role="alert">{error}</p> : null}
      </div>
    )
  }
  return (
    <div className="account-add" role="group" aria-label="Add account">
      {signin.url ? (
        <>
          <p className="picker-note">
            Open this link in a private window, or in the browser profile signed in to the account you want. Your usual browser would pick the account it is already signed in to.
          </p>
          <pre className="handoff-text account-link" tabIndex={0} aria-label="Sign-in link">{signin.url}</pre>
          <div className="picker-foot">
            <button type="button" className="button-soft" onClick={() => {
              if (native) native.copyText(signin.url!)
              else void navigator.clipboard.writeText(signin.url!).catch(() => undefined)
            }}>Copy link</button>
          </div>
        </>
      ) : <p className="picker-note">Starting {agentName(agent)}’s sign-in…</p>}
      {takesCode && signin.state === 'waiting_for_user' && signin.url ? (
        <div className="preset-form">
          <input aria-label="Sign-in code" placeholder="Paste the code the page shows" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.preventDefault() }} />
          <button type="button" className="button-primary" disabled={!code.trim()} onClick={() => {
            api.sendAccountCode(signin.id, code.trim()).then((next) => { setSignin(next); setCode('') }, (e: unknown) => setError(message(e)))
          }}>Continue</button>
        </div>
      ) : null}
      {!takesCode && signin.state === 'waiting_for_user' && signin.url ? (
        <p className="picker-note">{agentName(agent)} finishes by itself once you have signed in on that page.</p>
      ) : null}
      {signin.state === 'checking' || signin.state === 'verified' ? <p className="picker-note" role="status">{signin.message}</p> : null}
      {error ? <p className="picker-note agent-state-problem" role="alert">{error}</p> : null}
      {!signin.endedAt ? (
        <div className="picker-foot">
          <button type="button" className="button-soft" onClick={() => { void api.cancelAccountSignin(signin.id).then(() => api.accountSignin(signin.id)).then(setSignin, () => undefined) }}>Cancel sign-in</button>
        </div>
      ) : null}
    </div>
  )
}
