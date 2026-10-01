import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { api, type GitView } from '../api.ts'
import { usePopover } from '../usePopover.ts'
import { BranchIcon, ChevronDownIcon, PlusIcon } from './icons.tsx'

interface BranchPickerProps {
  projectPath: string
  /** Changes when the branch may have moved under us, e.g. a turn finished. */
  refreshKey?: string
}

const label = (git: GitView): string => git.branch ?? (git.head ? `detached at ${git.head}` : 'no commits')

/**
 * The composer's branch pill: the project's current Git branch, with search, switch,
 * create-and-switch and push. Hidden when the folder is not a repository.
 */
export function BranchPicker({ projectPath, refreshKey }: BranchPickerProps) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>()
  const [git, setGit] = useState<GitView>()
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const input = useRef<HTMLInputElement>(null)

  const refresh = useCallback(() => {
    let live = true
    api.gitState(projectPath).then((state) => { if (live) setGit(state) }, () => { if (live) setGit(undefined) })
    return () => { live = false }
  }, [projectPath])

  useEffect(() => refresh(), [refresh, refreshKey])
  useEffect(() => {
    const onFocus = (): void => { refresh() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])
  useEffect(() => {
    if (!open) return
    setError(''); setNotice('')
    input.current?.focus()
    return refresh()
  }, [open, refresh])

  if (!git?.repo) return null

  const act = async (name: string, run: () => Promise<GitView>, done: (state: GitView) => string): Promise<void> => {
    setPending(name); setError(''); setNotice('')
    try {
      const state = await run()
      setGit(state)
      setQuery('')
      setNotice(done(state))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      refresh()
    } finally {
      setPending('')
    }
  }
  const switchTo = (branch: string): Promise<void> => act(branch, () => api.switchBranch(projectPath, branch), (s) => `Switched to ${s.branch ?? branch}.`)
  const create = (branch: string): Promise<void> => act(branch, () => api.createBranch(projectPath, branch), (s) => `Created and switched to ${s.branch ?? branch}.`)
  const push = (): Promise<void> => act('push', () => api.pushBranch(projectPath), (s) => `Pushed to ${s.pushedTo ?? 'the remote'}.`)

  const wanted = query.trim()
  const matches = git.branches.filter((b) => b.toLowerCase().includes(wanted.toLowerCase())).slice(0, 50)
  const exact = git.branches.includes(wanted)
  const busy = git.busy.length > 0
  const switchBlocked = busy ? 'A conversation is working' : git.changeCount > 0 ? 'Commit or stash first' : ''

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || !wanted || pending) return
    event.preventDefault()
    if (exact) { if (!switchBlocked && wanted !== git.branch) void switchTo(wanted) }
    else if (!busy) void create(wanted)
  }

  return (
    <div className="picker branch-picker" ref={ref}>
      <button type="button" className="branch-button" aria-label="Branch" aria-expanded={open} title="Git branch for every conversation in this project"
        onClick={() => setOpen(!open)}>
        <BranchIcon />
        <span className="branch-name">{label(git)}</span>
        {git.ahead ? <span className="branch-ahead" title={`${git.ahead} commit${git.ahead === 1 ? '' : 's'} not pushed`}>↑{git.ahead}</span> : null}
        <ChevronDownIcon className="chevron" />
      </button>
      {open ? (
        <div className="picker-panel branch-panel" role="dialog" aria-label="Branches">
          <input ref={input} aria-label="Find or name a branch" placeholder="Find a branch, or name a new one…" value={query}
            onChange={(e) => { setQuery(e.target.value); setError('') }} onKeyDown={onKeyDown} />
          <p className="picker-note">Applies to every conversation in this project.</p>
          {busy ? <p className="picker-note branch-warn">Switching waits until {git.busy.join(', ')} {git.busy.length === 1 ? 'finishes' : 'finish'}.</p> : null}
          {git.changeCount > 0 ? (
            <p className="picker-note" title={git.changes.join('\n')}>
              {git.changeCount} uncommitted change{git.changeCount === 1 ? '' : 's'}. A new branch keeps them; switching needs them committed or stashed.
            </p>
          ) : null}
          <div role="listbox" aria-label="Local branches" className="picker-list">
            {matches.map((branch) => {
              const current = branch === git.branch
              return (
                <button key={branch} type="button" role="option" aria-selected={current} className="picker-row branch-row"
                  disabled={current || Boolean(switchBlocked) || Boolean(pending)} onClick={() => void switchTo(branch)}>
                  <BranchIcon />
                  <span className="picker-title">{branch}</span>
                  <span className="picker-detail">{current ? 'Current' : pending === branch ? 'Switching…' : switchBlocked}</span>
                </button>
              )
            })}
            {wanted && !exact ? (
              <button type="button" className="picker-row branch-row" disabled={busy || Boolean(pending)} onClick={() => void create(wanted)}>
                <PlusIcon />
                <span className="picker-title">New branch “{wanted}”</span>
                <span className="picker-detail">{pending === wanted ? 'Creating…' : busy ? 'Waiting' : `from ${label(git)}`}</span>
              </button>
            ) : null}
            {!wanted && matches.length === 0 ? <p className="picker-note">No local branches yet.</p> : null}
          </div>
          {error ? <p className="picker-note branch-error" role="alert">{error}</p> : null}
          {notice ? <p className="picker-note" role="status">{notice}</p> : null}
          <div className="branch-foot">
            <span className="picker-note">{git.upstream ? `Tracks ${git.upstream}${git.behind ? ` · ${git.behind} behind` : ''}` : 'Not pushed yet'}</span>
            <button type="button" className="branch-push" disabled={!git.branch || !git.head || Boolean(pending)} onClick={() => void push()}>
              {pending === 'push' ? 'Pushing…' : 'Push'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
