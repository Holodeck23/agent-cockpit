import { useEffect, useState } from 'react'
import { api, type NativeMemorySelectionView, type NativeMemoryView, type OfferedPlugin, type SkillSelectionView, type SkillsView } from '../api.ts'

// The user's own Claude memory and skills for one project (W13 U5/U6). Each is a choice of one
// reviewed revision for the project's Claude account: a change afterwards stops new conversations
// until it is chosen again, and a choice made for another account is not loaded. Mac only; the
// routes name accounts and counts, never content, and no folder but where a linked skill points.

const ACCOUNT_CHANGED = 'cockpit:account-changed'
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const when = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

const EXCLUDED: Readonly<Record<NonNullable<SkillsView['offered']>['excluded'][number]['reason'], string>> = {
  linked: 'linked from elsewhere, not included until it can be reviewed',
  'not-a-file': 'not a regular file',
  'too-large': 'over the size limit',
}

export type ChoiceState = 'none' | 'current' | 'changed' | 'other-account'

/** What a project's choice means for its next Claude conversation, given the account it now runs on. */
export function choiceState(selection: { destinationAccountId: string; current?: boolean } | null, accountId: string | undefined): ChoiceState {
  if (!selection) return 'none'
  if (accountId && selection.destinationAccountId !== accountId) return 'other-account'
  return selection.current === false ? 'changed' : 'current'
}

interface MemoryChoiceProps {
  readonly view: NativeMemoryView
  /** The project's Claude account now; undefined while it is being read. */
  readonly accountId?: string
  readonly onChoose: (sourceAccountId: string, replacing?: string) => void
  readonly onRevoke: (selectionId: string) => void
}

export function MemoryChoice({ view, accountId, onChoose, onRevoke }: MemoryChoiceProps) {
  const chosen = view.selection
  const state = choiceState(chosen, accountId)
  return (
    <div className="field claude-setup" role="group" aria-label="Claude memory">
      <strong>Claude memory</strong>
      <small>New conversations start with a private copy of the memory you choose. What they remember stays with that conversation; the chosen memory is not changed.</small>
      <MemoryStatus selection={chosen} state={state} />
      <ul className="claude-setup-list">
        {view.sources.map((source) => {
          const isChosen = chosen?.sourceAccountId === source.accountId && state === 'current'
          return (
            <li key={source.accountId} className="claude-setup-row">
              <span><strong>{source.label}</strong>{source.available ? null : <small>No memory saved for this project yet</small>}</span>
              {isChosen ? <small className="claude-setup-chosen">Chosen</small>
                : <button type="button" className="button-soft" disabled={!source.available}
                  onClick={() => onChoose(source.accountId, chosen?.id)}>
                  {chosen?.sourceAccountId === source.accountId && state === 'changed' ? 'Use the current memory' : 'Use this memory'}
                </button>}
            </li>
          )
        })}
      </ul>
      {chosen ? <button type="button" className="button-soft claude-setup-stop" onClick={() => onRevoke(chosen.id)}>Stop loading memory</button> : null}
    </div>
  )
}

function MemoryStatus({ selection, state }: { selection: NativeMemorySelectionView | null; state: ChoiceState }) {
  if (!selection || state === 'none') return <small role="status">Not loading any memory.</small>
  const from = `${selection.sourceLabel}, ${plural(selection.fileCount, 'file')}, chosen ${when(selection.selectedAt)}`
  if (state === 'other-account') return <small role="status" className="claude-setup-warn">Chosen for a different Claude account, so it is not loaded. Choose again for this project&apos;s account.</small>
  if (state === 'changed') return <small role="alert" className="claude-setup-warn">Changed since you chose it ({from}). New Claude conversations here will not start until you review it again or stop loading it.</small>
  return <small role="status">Loading {from}.</small>
}

interface SkillChoiceProps {
  readonly view: SkillsView
  readonly accountId?: string
  /** `includeLinks`: the linked entries the user ticked after seeing where they point; `includePlugins`: plugin keys. */
  readonly onChoose: (replacing: string | undefined, includeLinks: readonly string[], includePlugins: readonly string[]) => void
  readonly onRevoke: (selectionId: string) => void
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item) => b.includes(item))

export function SkillChoice({ view, accountId, onChoose, onRevoke }: SkillChoiceProps) {
  const chosen = view.selection
  const state = choiceState(chosen, accountId)
  const offered = view.offered
  const chosenLinks = (chosen?.includedLinks ?? []).map((link) => link.path)
  const chosenPlugins = chosen?.includedPlugins ?? []
  const [ticked, setTicked] = useState<readonly string[]>(chosenLinks)
  const [tickedPlugins, setTickedPlugins] = useState<readonly string[]>(chosenPlugins)
  // A new or replaced choice resets the ticks to what it includes.
  useEffect(() => {
    setTicked((chosen?.includedLinks ?? []).map((link) => link.path))
    setTickedPlugins(chosen?.includedPlugins ?? [])
  }, [chosen?.id])
  const plugins = offered?.plugins ?? []
  const pluginOffer = plugins.filter((plugin) => plugin.includable)
  const pluginLeftOut = plugins.filter((plugin) => !plugin.includable)
  const reviewable = offered?.excluded.filter((row) => row.reason === 'linked' && row.includable) ?? []
  const leftOut = offered?.excluded.filter((row) => !(row.reason === 'linked' && row.includable)) ?? []
  const pending = state === 'current' && (!sameSet(ticked, chosenLinks) || !sameSet(tickedPlugins, chosenPlugins))
  const flip = (now: readonly string[], item: string): readonly string[] => (now.includes(item) ? now.filter((entry) => entry !== item) : [...now, item])
  const toggle = (path: string): void => setTicked((now) => flip(now, path))
  return (
    <div className="field claude-setup" role="group" aria-label="Your Claude skills">
      <strong>Your Claude skills</strong>
      <small>Skills, commands and agents from your CLI default profile, loaded in this project&apos;s Claude conversations as they were when you chose them.</small>
      <SkillStatus selection={chosen} state={state} />
      {view.problem ? <small role="alert" className="field-error">{view.problem}</small> : null}
      {offered ? <>
        <small>On offer: {plural(offered.skills.length, 'skill')}, {plural(offered.commands.length, 'command')}, {plural(offered.agents.length, 'agent')}.</small>
        {offered.skills.length + offered.commands.length + offered.agents.length > 0 ? <details className="claude-setup-names">
          <summary>Show names</summary>
          <NameList label="Skills" names={offered.skills} />
          <NameList label="Commands" names={offered.commands} />
          <NameList label="Agents" names={offered.agents} />
        </details> : null}
        {reviewable.length ? <>
          <small>Linked from elsewhere ({reviewable.length}). Each is included only if you tick it, after checking where it points:</small>
          <ul className="claude-setup-list">{reviewable.map((row) => (
            <li key={row.path} className="claude-setup-row">
              <label className="claude-setup-include">
                <input type="checkbox" checked={ticked.includes(row.path)} onChange={() => toggle(row.path)} />
                <span><strong>{row.path}</strong><small>links to {row.target}</small></span>
              </label>
            </li>
          ))}</ul>
        </> : null}
        {pluginOffer.length ? <>
          <small>Plugins you enabled ({pluginOffer.length}). Only their skills, commands and agents can load here, never their hooks or connectors. Each is included only if you tick it:</small>
          <ul className="claude-setup-list">{pluginOffer.map((plugin) => (
            <li key={plugin.key} className="claude-setup-row">
              <label className="claude-setup-include">
                <input type="checkbox" checked={tickedPlugins.includes(plugin.key)} onChange={() => setTickedPlugins((now) => flip(now, plugin.key))} />
                <span><strong>{plugin.name}{plugin.version ? ` ${plugin.version}` : ''}</strong><small>{pluginSummary(plugin)}</small></span>
              </label>
            </li>
          ))}</ul>
        </> : null}
        {pluginLeftOut.length ? <>
          <small>Plugins not offered ({pluginLeftOut.length}):</small>
          <ul className="claude-setup-list">{pluginLeftOut.map((plugin) => (
            <li key={plugin.key} className="claude-setup-row"><span><strong>{plugin.name}</strong><small>{plugin.problem ?? 'no skills, commands or agents; its connectors do not load here'}</small></span></li>
          ))}</ul>
        </> : null}
        {leftOut.length ? <>
          <small>Not included ({leftOut.length}):</small>
          <ul className="claude-setup-list">{leftOut.map((row) => (
            <li key={row.path} className="claude-setup-row"><span><strong>{row.path}</strong><small>{row.reason === 'linked' && !row.target ? 'a link that points nowhere' : EXCLUDED[row.reason]}</small></span></li>
          ))}</ul>
        </> : null}
      </> : null}
      <div className="claude-setup-actions">
        {offered && (state !== 'current' || pending)
          ? <button type="button" className="button-soft" onClick={() => onChoose(chosen?.id, ticked, tickedPlugins)}>
            {pending ? 'Update my choice' : state === 'changed' ? 'Use the current version' : 'Use my skills'}</button>
          : null}
        {chosen ? <button type="button" className="button-soft" onClick={() => onRevoke(chosen.id)}>Stop loading my skills</button> : null}
      </div>
    </div>
  )
}

function SkillStatus({ selection, state }: { selection: SkillSelectionView | null; state: ChoiceState }) {
  if (!selection || state === 'none') return <small role="status">Not loading your skills.</small>
  if (state === 'other-account') return <small role="status" className="claude-setup-warn">Chosen for a different Claude account, so they are not loaded. Choose again for this project&apos;s account.</small>
  const links = selection.includedLinks?.length ?? 0, plugins = selection.includedPlugins?.length ?? 0
  const extras = [links ? plural(links, 'linked entry', 'linked entries') : '', plugins ? plural(plugins, 'plugin') : ''].filter(Boolean)
  const counts = `${plural(selection.counts.skills, 'skill')}, ${plural(selection.counts.commands, 'command')}, ${plural(selection.counts.agents, 'agent')}${extras.length ? `, with ${extras.join(' and ')}` : ''}`
  if (state === 'changed') return <small role="alert" className="claude-setup-warn">Changed since you chose them on {when(selection.selectedAt)}. New Claude conversations here will not start until you review them again or stop loading them.</small>
  return <small role="status">Loading {counts}, chosen {when(selection.selectedAt)}.</small>
}

function pluginSummary(plugin: OfferedPlugin): string {
  const holds = `${plural(plugin.skills ?? 0, 'skill')}, ${plural(plugin.commands ?? 0, 'command')}, ${plural(plugin.agents ?? 0, 'agent')}`
  const without = [plugin.leftOut?.hooks ? 'hooks' : '', plugin.leftOut?.connectors ? 'connectors' : ''].filter(Boolean)
  return without.length ? `${holds}; its ${without.join(' and ')} are left out` : holds
}

function NameList({ label, names }: { label: string; names: readonly string[] }) {
  return names.length ? <p className="claude-setup-namelist"><span>{label}</span> {names.join(', ')}</p> : null
}

/** Both choices for one project, re-read when the window regains focus or its Claude account changes. */
export function ProjectClaudeSetup({ projectId, projectPath }: { projectId: string; projectPath: string }) {
  const [memory, setMemory] = useState<NativeMemoryView>()
  const [skills, setSkills] = useState<SkillsView>()
  const [accountId, setAccountId] = useState<string>()
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const refresh = (): void => setRevision((value) => value + 1)
    const changed = (event: Event): void => {
      const detail = (event as CustomEvent<{ projectPath: string; agent: string }>).detail
      if (detail?.projectPath === projectPath && detail.agent === 'claude') refresh()
    }
    window.addEventListener(ACCOUNT_CHANGED, changed)
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener(ACCOUNT_CHANGED, changed); window.removeEventListener('focus', refresh) }
  }, [projectPath])

  useEffect(() => {
    let live = true
    void Promise.allSettled([api.nativeMemory(projectId), api.projectSkills(projectId), api.projectAccounts(projectId)]).then(([m, s, a]) => {
      if (!live) return
      if (m.status === 'fulfilled') setMemory(m.value)
      if (s.status === 'fulfilled') setSkills(s.value)
      if (a.status === 'fulfilled') setAccountId(a.value.selection.claude)
      const failed = [m, s, a].find((r): r is PromiseRejectedResult => r.status === 'rejected')
      setError(failed ? message(failed.reason) : '')
    })
    return () => { live = false }
  }, [projectId, revision])

  const act = (action: () => Promise<unknown>): void => {
    setBusy(true)
    setError('')
    action().then(() => setRevision((value) => value + 1), (e: unknown) => setError(message(e))).finally(() => setBusy(false))
  }

  return (
    <fieldset className="claude-setup-group" disabled={busy}>
      {memory ? <MemoryChoice view={memory} accountId={accountId}
        onChoose={(source, replacing) => act(() => api.chooseNativeMemory(projectId, source, replacing))}
        onRevoke={(id) => act(() => api.revokeNativeMemory(projectId, id))} /> : <small className="field">Checking Claude memory…</small>}
      {skills ? <SkillChoice view={skills} accountId={accountId}
        onChoose={(replacing, includeLinks, includePlugins) => act(() => api.chooseProjectSkills(projectId, replacing, includeLinks, includePlugins))}
        onRevoke={(id) => act(() => api.revokeProjectSkills(projectId, id))} /> : <small className="field">Checking your Claude skills…</small>}
      {error ? <small role="alert" className="field-error">{error}</small> : null}
    </fieldset>
  )
}
